"""
torgigov_daily.py — ежедневный парсер новых лотов torgi.gov.by

Алгоритм:
  1. GET /known-lots  → {slug: [lot_id, ...]}
  2. GET /categories  → список из KV
  3. По каждой категории: GET /api-lots?page=0&pagesize=50&sort=approvetime
     Сравниваем ID с known_lots — находим новые (остановка при первом известном)
  4. POST /add-lots   → добавляем новые ID
  5. POST /save-daily-lots → сохраняем детали новых лотов
  6. Ждём NOTIFY_TIME_UTC → POST /send-notifications
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

WORKER_URL    = cfg.TORGIGOV_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET


# ════════════════════════════════════════════════════════════
# WORKER API
# ════════════════════════════════════════════════════════════

def _get(path: str) -> dict:
    r = lib._SESSION.get(
        f"{WORKER_URL}/{path}",
        headers={"X-API-Key": PARSER_SECRET},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _post(path: str, body: dict) -> dict:
    r = requests.post(
        f"{WORKER_URL}/{path}",
        json=body,
        headers={"X-API-Key": PARSER_SECRET, "Content-Type": "application/json"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def fetch_known_lots() -> dict[str, set[str]]:
    """GET /known-lots → {slug: set(lot_id)}"""
    try:
        data = _get("known-lots")
        return {slug: set(str(i) for i in ids) for slug, ids in data.items()}
    except Exception as e:
        print(f"[!] known-lots: {e} — пустая база")
        return {}


def fetch_categories() -> list[dict]:
    try:
        return _get("categories")
    except Exception as e:
        print(f"[!] categories: {e}")
        return []


def should_do_full_reset() -> bool:
    try:
        data  = _get("status")
        last  = data.get("last_full_reset")
        if not last:
            return False
        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
        days    = (datetime.now(timezone.utc) - last_dt).days
        print(f"[i] Последний сброс: {last} ({days} дн. назад)")
        return days >= cfg.FULL_RESET_EVERY_DAYS
    except Exception as e:
        print(f"[!] status: {e}")
        return False


# ════════════════════════════════════════════════════════════
# ОПОВЕЩЕНИЯ ОБ ОШИБКЕ
# ════════════════════════════════════════════════════════════

_ALERT_SUBJECT = "⚠️ torgigov: парсер завершился с ошибкой"


def _alert_message(error: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"Парсер torgi.gov.by завершился с ошибкой:\n\n"
        f"{error}\n\n"
        f"Время: {ts}\n\n"
        f"Что делать:\n"
        f"  1. Проверить деплой Cloudflare Worker\n"
        f"  2. Проверить доступность: GET {WORKER_URL}/status\n"
        f"  3. Перезапустить: Actions → torgigov_daily → Run workflow"
    )


def send_alert_email(error: str) -> None:
    to_addr   = getattr(cfg, "ALERT_EMAIL", "blacksabbrath@gmail.com")
    smtp_host = os.environ.get("ALERT_SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("ALERT_SMTP_PORT", "587"))
    smtp_user = os.environ.get("ALERT_SMTP_USER", "")
    smtp_pass = os.environ.get("ALERT_SMTP_PASS", "")
    if not smtp_user or not smtp_pass:
        print("  [!] Email: ALERT_SMTP_USER / ALERT_SMTP_PASS не заданы")
        return
    msg           = MIMEText(_alert_message(error), "plain", "utf-8")
    msg["Subject"] = _ALERT_SUBJECT
    msg["From"]    = smtp_user
    msg["To"]      = to_addr
    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as s:
            s.ehlo(); s.starttls(); s.login(smtp_user, smtp_pass)
            s.sendmail(smtp_user, [to_addr], msg.as_string())
        print(f"  [✓] Email → {to_addr}")
    except Exception as e:
        print(f"  [✗] Email: {e}")


def send_alert_telegram(error: str) -> None:
    bot_token = os.environ.get("BOT_TOKEN", "")
    chat_id   = os.environ.get("ALERT_TELEGRAM_CHAT_ID", getattr(cfg, "ALERT_TELEGRAM_CHAT_ID", ""))
    if not bot_token or not chat_id:
        print("  [!] Telegram: BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID не заданы")
        return
    text = f"<b>{_ALERT_SUBJECT}</b>\n\n" + _alert_message(error).replace("&","&amp;").replace("<","&lt;")
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=20,
        )
        if r.ok:
            print(f"  [✓] Telegram → chat_id={chat_id}")
        else:
            print(f"  [✗] Telegram: {r.status_code} {r.text[:100]}")
    except Exception as e:
        print(f"  [✗] Telegram: {e}")


def send_alert(error: str) -> None:
    print("\n[⚠] Отправляю оповещение об ошибке…")
    send_alert_email(error)
    send_alert_telegram(error)


# ════════════════════════════════════════════════════════════
# ПАРСИНГ ОДНОЙ КАТЕГОРИИ
# ════════════════════════════════════════════════════════════

def parse_category_daily(cat: dict, known_ids: set[str]) -> list[dict]:
    """
    Запрашивает первую страницу API, находит новые лоты.
    Если все лоты на странице новые — запрашивает следующую.
    Останавливается при первом известном lot_id.
    """
    slug   = cat["slug"]
    cat_id = cat["category_id"]
    label  = cat["label"]
    print(f"\n[+] Категория: {label}")

    all_new: list[dict] = []
    pagesize = cfg.DAILY_PAGE_SIZE
    page     = 0

    while True:
        print(f"  → стр. {page}: category={cat_id}")
        lots, total_pages = lib.fetch_lots_page(cat_id, slug, page=page, pagesize=pagesize)

        if not lots:
            print(f"  [i] Пустая страница — останавливаю")
            break

        new_on_page = lib.find_new_lots_by_id(lots, known_ids)
        all_new.extend(new_on_page)

        print(f"     лотов: {len(lots)}, новых: {len(new_on_page)}")

        # Если на странице есть известные — все остальные тоже известны
        if len(new_on_page) < len(lots):
            break
        # Все на странице новые и есть следующая — идём дальше
        if page + 1 < total_pages:
            page += 1
            lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)
        else:
            break

    print(f"  Новых лотов: {len(all_new)}")
    return all_new


# ════════════════════════════════════════════════════════════
# СОХРАНЕНИЕ
# ════════════════════════════════════════════════════════════

def save_new_lots(slug: str, new_lots: list[dict]) -> None:
    if not new_lots:
        return
    ids = [l["lot_id"] for l in new_lots if l["lot_id"]]
    try:
        r = _post("add-lots", {"slug": slug, "lot_ids": ids})
        print(f"  [✓] /add-lots: {r}")
    except Exception as e:
        print(f"  [✗] /add-lots: {e}")

    today = date.today().isoformat()
    try:
        r = _post("save-daily-lots", {
            "date": today, "slug": slug,
            "lots": new_lots, "ttl": cfg.DAILY_LOTS_TTL_SECONDS,
        })
        print(f"  [✓] /save-daily-lots: {r}")
    except Exception as e:
        print(f"  [✗] /save-daily-lots: {e}")


# ════════════════════════════════════════════════════════════
# РАССЫЛКА
# ════════════════════════════════════════════════════════════

def wait_until_notify_time() -> None:
    hour, minute = map(int, cfg.NOTIFY_TIME_UTC.split(":"))
    now    = datetime.now(timezone.utc)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    wait   = (target - now).total_seconds()
    if wait > 0:
        print(f"\n[→] Жду до {cfg.NOTIFY_TIME_UTC} UTC ({int(wait // 60)} мин)…")
        time.sleep(wait)


def send_notifications(slugs: list[str]) -> None:
    today = date.today().isoformat()
    for slug in slugs:
        print(f"  [→] /send-notifications: {slug}")
        try:
            r = _post("send-notifications", {"date": today, "slug": slug})
            print(f"  [✓] {r}")
        except Exception as e:
            print(f"  [✗] {e}")


# ════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════

def random_delay() -> None:
    import random
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        print("[i] Рандомная задержка пропущена.")
        return
    delay = random.randint(0, cfg.RANDOM_DELAY_MAX_SECONDS)
    print(f"[i] Рандомная задержка: {delay} сек ({delay // 60} мин)")
    time.sleep(delay)


def main() -> None:
    print("=" * 60)
    print("  torgi.gov.by — дневной парсинг")
    print("=" * 60)

    random_delay()

    print("\n[1] Загружаю known_lots…")
    known_all = fetch_known_lots()
    for slug, ids in known_all.items():
        print(f"    {slug:45s}: {len(ids)} известных")

    print("\n[2] Загружаю категории…")
    categories = fetch_categories()
    if not categories:
        print("[!] Категории не получены — парсю напрямую…")
        categories = lib.parse_top_categories()
    if not categories:
        raise RuntimeError("Не удалось получить список категорий")
    print(f"    Категорий: {len(categories)}")

    total_new      = 0
    slugs_with_new = []

    for cat in categories:
        slug     = cat["slug"]
        known    = known_all.get(slug, set())
        new_lots = parse_category_daily(cat, known)

        if not new_lots:
            continue

        total_new += len(new_lots)
        slugs_with_new.append(slug)
        save_new_lots(slug, new_lots)
        lib.pause(cfg.DELAY_BETWEEN_SECTIONS)

    print(f"\n{'─' * 60}")
    print(f"  Итого новых лотов: {total_new}")

    print("\n[3] Проверяю необходимость полного сброса…")
    if should_do_full_reset():
        print("[→] Запускаю полный слепок…")
        snapshot_module.main()
    else:
        print("[i] Полный сброс не нужен.")

    if slugs_with_new:
        wait_until_notify_time()
        print("\n[4] Отправляю уведомления…")
        send_notifications(slugs_with_new)
    else:
        print("\n[4] Новых лотов нет — уведомления не отправляются.")

    print(f"\n{'=' * 60}")
    print("  Готово.")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        msg = str(e)
        print(f"\n[✗] КРИТИЧЕСКАЯ ОШИБКА: {msg}")
        send_alert(msg)
        sys.exit(1)
