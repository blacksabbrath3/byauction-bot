"""
torgigov_daily.py — ежедневный парсер новых лотов torgi.gov.by

Алгоритм:
  1. GET /torgigov/known-lots  → {slug: [path, ...]}
  2. Категории из torgigov_lib.TOP_CATEGORIES (хардкод — Angular SPA)
  3. По каждой категории парсим страницы каталога, ищем новые лоты
  4. POST /torgigov/add-lots   → добавляем новые пути в known_lots
  5. Парсим детали новых лотов → POST /torgigov/save-daily-lots
  6. Если прошло ≥ FULL_RESET_EVERY_DAYS → запускаем snapshot
  7. Ждём NOTIFY_TIME_UTC → POST /torgigov/send-notifications
"""

import os
import sys
import time
import smtplib
import requests
from email.mime.text import MIMEText
from datetime import date, datetime, timezone

import config as cfg
import torgigov_lib as lib
import torgigov_snapshot as snapshot_module
from proxy_pool import ProxyPoolExhausted

WORKER_URL    = cfg.TORGIGOV_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET


# ════════════════════════════════════════════════════════════
# WORKER API
# ════════════════════════════════════════════════════════════

def _get(path: str) -> dict:
    r = lib.SESSION.get(
        f"{WORKER_URL}{path}",
        headers={"X-API-Key": PARSER_SECRET},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _post(path: str, body: dict) -> dict:
    r = requests.post(
        f"{WORKER_URL}{path}",
        json=body,
        headers={"X-API-Key": PARSER_SECRET},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def fetch_known_lots() -> dict[str, dict[str, int]]:
    """
    GET /torgigov/known-lots → {slug: [path, ...]}
    Конвертируем в {slug: {path: rank}} для алгоритма find_new_lots.
    """
    try:
        data = _get("/known-lots")
        result = {}
        for slug, value in data.items():
            if isinstance(value, list):
                result[slug] = {path: rank for rank, path in enumerate(value)}
            elif isinstance(value, dict):
                result[slug] = {k: int(v) for k, v in value.items()}
            else:
                result[slug] = {}
        return result
    except Exception as e:
        print(f"[!] Не удалось получить known_lots: {e} — пустая база")
        return {}


def should_do_full_reset() -> bool:
    try:
        data = _get("/status")
        last_reset = data.get("last_full_reset")
        if not last_reset:
            return False
        last_dt = datetime.fromisoformat(last_reset.replace("Z", "+00:00"))
        days = (datetime.now(timezone.utc) - last_dt).days
        print(f"[i] Последний сброс: {last_reset} ({days} дн. назад)")
        return days >= cfg.FULL_RESET_EVERY_DAYS
    except Exception as e:
        print(f"[!] Не удалось проверить /status: {e}")
        return False


# ════════════════════════════════════════════════════════════
# ПАРСИНГ КАТЕГОРИИ
# ════════════════════════════════════════════════════════════

def parse_category_daily(cat: dict, snapshot: dict[str, int]) -> list[str]:
    """
    Парсит категорию постранично, останавливается при обнаружении
    известных лотов (алгоритм find_new_lots).
    """
    slug   = cat["slug"]
    cat_id = cat["category_id"]
    label  = cat["label"]
    print(f"\n[+] Категория: {label}")

    all_daily: list[str] = []
    page = 1
    stopped = False

    while not stopped:
        url = lib.build_catalog_url(slug, cat_id, page)
        print(f"  → стр. {page}: {url}")

        soup = lib.get_soup(url)
        if soup is None:
            print("  [!] Пропуск страницы")
            break

        found = lib.extract_lot_urls(soup)
        print(f"     лотов на странице: {len(found)}")
        if not found:
            break

        prev_len = len(all_daily)
        for p in found:
            if p not in all_daily:
                all_daily.append(p)

        new_paths = lib.find_new_lots(all_daily, snapshot)

        added_this_page = len(all_daily) - prev_len
        if added_this_page > 0 and len(new_paths) < len(all_daily):
            stopped = True
        elif lib.get_next_page_url(soup, url) is None:
            break
        else:
            page += 1
            lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)

    new_paths = lib.find_new_lots(all_daily, snapshot)
    print(f"  Новых: {len(new_paths)} из {len(all_daily)} проверенных")
    lib.pause(cfg.DELAY_BETWEEN_SECTIONS)
    return new_paths


# ════════════════════════════════════════════════════════════
# СОХРАНЕНИЕ В KV
# ════════════════════════════════════════════════════════════

def add_to_known_lots(slug: str, new_paths: list[str]) -> None:
    if not new_paths:
        return
    try:
        r = _post("/add-lots", {"slug": slug, "paths": new_paths})
        print(f"  [✓] /add-lots: {str(r)[:120]}")
    except Exception as e:
        print(f"  [✗] /add-lots: {e}")


def fetch_details_and_save(slug: str, label: str, new_paths: list[str]) -> None:
    if not new_paths:
        return
    print(f"\n  Парсю детали {len(new_paths)} лотов «{label}»…")
    lots = []
    for i, path in enumerate(new_paths, 1):
        print(f"    [{i}/{len(new_paths)}] {path}")
        lot = lib.parse_lot_details(path)
        lot["slug"] = slug
        lots.append(lot)
        lib.pause(cfg.DELAY_BETWEEN_LOT_PAGES)

    today = date.today().isoformat()
    try:
        r = _post("/save-daily-lots", {
            "date": today,
            "slug": slug,
            "lots": lots,
            "ttl":  cfg.DAILY_LOTS_TTL_SECONDS,
        })
        print(f"  [✓] /save-daily-lots: {str(r)[:120]}")
    except Exception as e:
        print(f"  [✗] /save-daily-lots: {e}")


# ════════════════════════════════════════════════════════════
# РАССЫЛКА
# ════════════════════════════════════════════════════════════

def wait_until_notify_time() -> None:
    hour, minute = map(int, cfg.NOTIFY_TIME_UTC.split(":"))
    now    = datetime.now(timezone.utc)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    wait_sec = (target - now).total_seconds()
    if wait_sec > 0:
        print(f"\n[→] Жду до {cfg.NOTIFY_TIME_UTC} UTC ({int(wait_sec // 60)} мин)…")
        time.sleep(wait_sec)
    else:
        print(f"\n[→] Время рассылки {cfg.NOTIFY_TIME_UTC} UTC наступило, рассылаю сразу.")


def send_notifications(slugs: list[str]) -> None:
    today = date.today().isoformat()
    for slug in slugs:
        print(f"  [→] /send-notifications: {slug} за {today}")
        try:
            r = _post("/send-notifications", {"date": today, "slug": slug})
            print(f"  [✓] {str(r)[:120]}")
        except Exception as e:
            print(f"  [✗] /send-notifications [{slug}]: {e}")


# ════════════════════════════════════════════════════════════
# ОПОВЕЩЕНИЯ ОБ ОШИБКЕ ПРОКСИ
# ════════════════════════════════════════════════════════════

_ALERT_SUBJECT = "⚠️ torgigov: все прокси исчерпаны"

def _alert_message(error: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"Парсер torgi.gov.by завершился с ошибкой:\n\n"
        f"{error}\n\n"
        f"Все {cfg.MAX_PROXY_RETRIES} прокси из пула RU/BY оказались нерабочими.\n"
        f"Время: {ts}\n\n"
        f"Что делать:\n"
        f"  1. Проверить доступность torgi.gov.by через RU/BY VPN\n"
        f"  2. Добавить свежие прокси в PROXY_EXTRA_SOURCES в config.py\n"
        f"  3. Перезапустить workflow вручную: Actions → torgigov_daily → Run workflow"
    )


def send_alert_email(error: str) -> None:
    """Отправляет письмо через SMTP. Настройки берутся из env/config."""
    to_addr  = getattr(cfg, "ALERT_EMAIL", "blacksabbrath@gmail.com")
    smtp_host = os.environ.get("ALERT_SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("ALERT_SMTP_PORT", "587"))
    smtp_user = os.environ.get("ALERT_SMTP_USER", "")
    smtp_pass = os.environ.get("ALERT_SMTP_PASS", "")

    if not smtp_user or not smtp_pass:
        print(f"  [!] Email: ALERT_SMTP_USER / ALERT_SMTP_PASS не заданы — письмо не отправлено")
        return

    msg = MIMEText(_alert_message(error), "plain", "utf-8")
    msg["Subject"] = _ALERT_SUBJECT
    msg["From"]    = smtp_user
    msg["To"]      = to_addr

    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as s:
            s.ehlo()
            s.starttls()
            s.login(smtp_user, smtp_pass)
            s.sendmail(smtp_user, [to_addr], msg.as_string())
        print(f"  [✓] Email отправлен → {to_addr}")
    except Exception as e:
        print(f"  [✗] Email не отправлен: {e}")


def send_alert_telegram(error: str) -> None:
    """Отправляет сообщение в Telegram через Bot API."""
    bot_token = os.environ.get("BOT_TOKEN", getattr(cfg, "BOT_TOKEN", ""))
    chat_id   = os.environ.get("ALERT_TELEGRAM_CHAT_ID",
                               getattr(cfg, "ALERT_TELEGRAM_CHAT_ID", ""))

    if not bot_token or not chat_id:
        print(f"  [!] Telegram: BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID не заданы")
        return

    text = f"<b>{_ALERT_SUBJECT}</b>\n\n" + _alert_message(error).replace("&", "&amp;").replace("<", "&lt;")
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=20,
        )
        if r.ok:
            print(f"  [✓] Telegram уведомление отправлено → chat_id={chat_id}")
        else:
            print(f"  [✗] Telegram API: {r.status_code} {r.text[:200]}")
    except Exception as e:
        print(f"  [✗] Telegram не отправлен: {e}")


def send_proxy_alert(error: str) -> None:
    """Отправляет уведомление всеми доступными каналами."""
    print("\n[⚠] Отправляю оповещение об исчерпании прокси…")
    send_alert_email(error)
    send_alert_telegram(error)


# ════════════════════════════════════════════════════════════
# ТОЧКА ВХОДА
# ════════════════════════════════════════════════════════════

def random_delay() -> None:
    import random
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        print("[i] Рандомная задержка пропущена (ручной запуск).")
        return
    delay = random.randint(0, cfg.RANDOM_DELAY_MAX_SECONDS)
    print(f"[i] Рандомная задержка: {delay} сек ({delay // 60} мин)")
    time.sleep(delay)


def main() -> None:
    print("=" * 60)
    print("  torgi.gov.by — дневной парсинг")
    print("=" * 60)

    random_delay()

    # 1. Загружаем known_lots
    print("\n[1] Загружаю known_lots…")
    known_all = fetch_known_lots()
    for slug, v in known_all.items():
        print(f"    {slug:40s}: {len(v)} известных")

    # 2. Категории из хардкода
    categories = lib.TOP_CATEGORIES
    print(f"\n[2] Категорий: {len(categories)} (хардкод)")

    total_new = 0
    slugs_with_new: list[str] = []

    # 3-5. По каждой категории
    for cat in categories:
        slug = cat["slug"]
        snap = known_all.get(slug, {})

        new_paths = parse_category_daily(cat, snap)
        if not new_paths:
            print(f"  Новых лотов нет.")
            continue

        total_new += len(new_paths)
        slugs_with_new.append(slug)
        add_to_known_lots(slug, new_paths)
        fetch_details_and_save(slug, cat["label"], new_paths)

    print(f"\n{'─' * 60}")
    print(f"  Итого новых лотов: {total_new}")

    # 6. Полный сброс если нужен
    print("\n[6] Проверяю необходимость полного сброса…")
    if should_do_full_reset():
        print("[→] Запускаю полный слепок…")
        snapshot_module.main()
    else:
        print("[i] Полный сброс не нужен.")

    # 7. Уведомления
    if slugs_with_new:
        wait_until_notify_time()
        print("\n[7] Отправляю уведомления…")
        send_notifications(slugs_with_new)
    else:
        print("\n[7] Новых лотов нет — уведомления не отправляются.")

    print(f"\n{'=' * 60}")
    print("  Готово.")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    try:
        main()
    except ProxyPoolExhausted as e:
        msg = str(e)
        print(f"\n[✗] КРИТИЧЕСКАЯ ОШИБКА: {msg}")
        send_proxy_alert(msg)
        sys.exit(1)
