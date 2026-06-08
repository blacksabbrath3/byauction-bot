"""
butb_daily.py — ежедневный парсер новых лотов et.butb.by

Алгоритм:
  1. GET /known-lots  → {slug: [lot_id, ...]}
  2. GET первой страницы листинга через Worker
  3. Парсим лоты, находим новые (сравнение с known_lots["all"])
     Если все на странице новые — переходим к следующей странице
  4. POST /add-lots   → регистрируем новые ID
  5. POST /save-daily-lots → сохраняем детали лотов в KV
  6. Ждём NOTIFY_TIME_UTC → POST /send-notifications

Особенность et.butb.by:
  Сайт использует ICEFaces (JSF). Пагинация работает через POST формы.
  Первая страница — GET, остальные — POST с состоянием формы.
  Сортировка на сайте нестандартная, поэтому определяем новые лоты
  по отсутствию lot_id в known_lots (не по позиции/ранку).
"""

import os
import sys
import time
import smtplib
import requests
from email.mime.text import MIMEText
from datetime import date, datetime, timezone

import config as cfg
import butb_lib as lib
import butb_snapshot as snapshot_module

WORKER_URL    = cfg.BUTB_WORKER_URL
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


def should_do_full_reset() -> bool:
    try:
        data   = _get("status")
        last   = data.get("last_full_reset")
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

_ALERT_SUBJECT = "⚠️ butb: парсер завершился с ошибкой"


def _alert_message(error: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"Парсер et.butb.by завершился с ошибкой:\n\n"
        f"{error}\n\n"
        f"Время: {ts}\n\n"
        f"Что делать:\n"
        f"  1. Проверить деплой Cloudflare Worker (butb-worker)\n"
        f"  2. Проверить доступность: GET {WORKER_URL}/status\n"
        f"  3. Перезапустить: Actions → butb_daily → Run workflow"
    )


def send_alert_email(error: str) -> None:
    to_addr   = getattr(cfg, "ALERT_EMAIL", "")
    smtp_host = os.environ.get("ALERT_SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("ALERT_SMTP_PORT", "587"))
    smtp_user = os.environ.get("ALERT_SMTP_USER", "")
    smtp_pass = os.environ.get("ALERT_SMTP_PASS", "")
    if not smtp_user or not smtp_pass or not to_addr:
        print("  [!] Email: ALERT_SMTP_USER / ALERT_SMTP_PASS / ALERT_EMAIL не заданы")
        return
    msg            = MIMEText(_alert_message(error), "plain", "utf-8")
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
    chat_id   = os.environ.get("ALERT_TELEGRAM_CHAT_ID",
                               getattr(cfg, "ALERT_TELEGRAM_CHAT_ID", ""))
    if not bot_token or not chat_id:
        print("  [!] Telegram: BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID не заданы")
        return
    text = f"<b>{_ALERT_SUBJECT}</b>\n\n" + _alert_message(error).replace("&", "&amp;").replace("<", "&lt;")
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
# ПАРСИНГ НОВЫХ ЛОТОВ
# ════════════════════════════════════════════════════════════

def parse_daily(known_ids: set[str]) -> list[dict]:
    """
    Обходит все страницы листинга и собирает новые лоты.
    Обходим ВСЕ страницы — БУТБ не гарантирует хронологический
    порядок, новый лот может быть на любой странице.
    """
    print(f"\n[→] Загружаю страницу 1…")
    soup = lib.fetch_listing_page(page=1)
    if not soup:
        print("[!] Первая страница недоступна")
        return []

    base_state  = lib.extract_form_state(soup)
    total_pages = lib.get_total_pages(soup)
    print(f"[i] Всего страниц: {total_pages}")

    all_new: list[dict] = []

    lots = lib.parse_lots_from_soup(soup)
    new_on_page = lib.find_new_lots_by_id(lots, known_ids)
    all_new.extend(new_on_page)
    print(f"    стр. 1: лотов={len(lots)}, новых={len(new_on_page)}")

    # Если на первой странице встретился известный лот — дальше не идём
    if len(new_on_page) < len(lots):
        return all_new

    for page in range(2, total_pages + 1):
        lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)
        print(f"\n[→] Загружаю страницу {page}/{total_pages}…")
        soup = lib.fetch_listing_page(page=page, base_state=base_state)
        if not soup:
            print(f"  [!] Страница {page} недоступна — пропускаю")
            continue

        lots = lib.parse_lots_from_soup(soup)
        if not lots:
            print(f"  [i] Страница {page} пуста — останавливаюсь")
            break

        new_on_page = lib.find_new_lots_by_id(lots, known_ids)
        all_new.extend(new_on_page)
        print(f"    стр. {page}: лотов={len(lots)}, новых={len(new_on_page)}")

        # Встретили известный лот — дальше не идём
        if len(new_on_page) < len(lots):
            break

    return all_new


# ════════════════════════════════════════════════════════════
# СОХРАНЕНИЕ
# ════════════════════════════════════════════════════════════

def save_new_lots(new_lots: list[dict]) -> None:
    if not new_lots:
        return

    slug = "all"
    ids  = [lot["lot_id"] for lot in new_lots if lot.get("lot_id")]

    try:
        r = _post("add-lots", {"slug": slug, "lot_ids": ids})
        print(f"  [✓] /add-lots: {r}")
    except Exception as e:
        print(f"  [✗] /add-lots: {e}")

    today = date.today().isoformat()
    try:
        r = _post("save-daily-lots", {
            "date": today,
            "slug": slug,
            "lots": new_lots,
            "ttl":  cfg.DAILY_LOTS_TTL_SECONDS,
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


def send_notifications() -> None:
    today = date.today().isoformat()
    print(f"  [→] /send-notifications: all")
    try:
        r = _post("send-notifications", {"date": today, "slug": "all"})
        print(f"  [✓] {r}")
    except Exception as e:
        print(f"  [✗] {e}")


# ════════════════════════════════════════════════════════════
# RANDOM DELAY
# ════════════════════════════════════════════════════════════

def random_delay() -> None:
    import random
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        print("[i] Рандомная задержка пропущена.")
        return
    delay = random.randint(0, cfg.RANDOM_DELAY_MAX_SECONDS)
    print(f"[i] Рандомная задержка: {delay} сек ({delay // 60} мин)")
    time.sleep(delay)


# ════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════

def main() -> None:
    print("=" * 60)
    print("  et.butb.by — дневной парсинг")
    print("=" * 60)

    random_delay()

    print("\n[1] Загружаю known_lots…")
    known_all = fetch_known_lots()
    known_ids = known_all.get("all", set())
    print(f"    Известных лотов: {len(known_ids)}")

    print("\n[2] Парсю новые лоты…")
    new_lots = parse_daily(known_ids)

    print(f"\n{'─' * 60}")
    print(f"  Итого новых лотов: {len(new_lots)}")

    print("\n[3] Проверяю необходимость полного сброса…")
    if should_do_full_reset():
        print("[→] Запускаю полный слепок…")
        snapshot_module.main()
    else:
        print("[i] Полный сброс не нужен.")

    if new_lots:
        print(f"\n[4] Сохраняю {len(new_lots)} новых лотов…")
        save_new_lots(new_lots)

        wait_until_notify_time()
        print("\n[5] Отправляю уведомления…")
        send_notifications()
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
