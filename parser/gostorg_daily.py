"""
gostorg_daily.py — ежедневный парсер gostorg.by

Сайт показывает последние ~20 лотов прямо на главной странице (новые
сверху) — без пагинации и без открытого API. Поэтому алгоритм проще,
чем у остальных источников:

  1. GET /known-lots         → set известных lot_id
  2. Снимаем верхние 20 карточек с главной страницы
  3. Новые — те, кого нет среди известных
  4. POST /add-lots          → добавляем ВСЕ увиденные id (не только новые —
                                 known_lots это просто set для дедупликации)
  5. POST /save-daily-lots   → сохраняем пачку новых лотов
  6. POST /save-daily-run    → отмечаем время запуска
  7. POST /send-notifications → рассылаем сразу
"""
import os, sys, time, random, logging, datetime, requests
import config as cfg
import lot_utils
from gostorg_lib import parse_listing

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [gostorg] %(levelname)s: %(message)s")
log = logging.getLogger(__name__)

WORKER_URL = cfg.GOSTORG_WORKER_URL
API_KEY    = cfg.PARSER_SECRET
HEADERS    = {"X-API-Key": API_KEY, "Content-Type": "application/json"}


def api_get(path):
    r = requests.get(f"{WORKER_URL}{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def api_post(path, body):
    r = requests.post(f"{WORKER_URL}{path}", json=body, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def load_known() -> set[str]:
    try:
        data = api_get("/known-lots")
        return set(str(x) for x in (data or []))
    except Exception as e:
        log.error(f"load_known: {e}")
        return set()


def collect_new_lots(known: set[str]) -> tuple[list[dict], list[dict]]:
    """
    Снимает всю ленту с главной страницы одним запросом (там сотни карточек,
    без пагинации/AJAX) и обрабатывает её пачками по GOSTORG_SNAPSHOT_LIMIT (20),
    останавливаясь после cfg.STOP_AFTER_CONSECUTIVE_KNOWN известных лотов подряд —
    единичный "выпавший" известный лот посреди ленты сбор не прерывает.

    Возвращает (новые_лоты, все_снятые_лоты).
    """
    all_lots = parse_listing()  # без limit — вся лента одним запросом
    if not all_lots:
        return [], []

    batch_size  = cfg.GOSTORG_SNAPSHOT_LIMIT
    all_new: list[dict] = []
    scanned: list[dict] = []
    consecutive = 0

    for i in range(0, len(all_lots), batch_size):
        batch = all_lots[i:i + batch_size]
        scanned.extend(batch)

        new_in_batch, stopped, consecutive = lot_utils.find_new_lots(
            batch, known, _consecutive_in=consecutive
        )
        all_new.extend(new_in_batch)

        log.info(
            f"  пачка {i // batch_size + 1}: лотов {len(batch)}, новых {len(new_in_batch)}"
            + (f" (серия {consecutive} известных — стоп)" if stopped else
               f" (известных подряд: {consecutive})" if consecutive else "")
        )

        if stopped:
            break

    return all_new, scanned


def random_delay():
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        return
    d = random.randint(0, cfg.RANDOM_DELAY_MAX_SECONDS)
    log.info(f"Задержка {d} сек")
    time.sleep(d)


def main():
    today = datetime.date.today().isoformat()
    log.info(f"=== gostorg_daily.py, {today} ===")

    if not WORKER_URL: log.error("GOSTORG_WORKER_URL не задан"); sys.exit(1)
    if not API_KEY:    log.error("PARSER_SECRET не задан");     sys.exit(1)

    random_delay()

    known = load_known()
    log.info(f"Известных лотов: {len(known)}")

    time.sleep(random.uniform(cfg.GOSTORG_DELAY_MIN, cfg.GOSTORG_DELAY_MAX))
    new_lots, scanned = collect_new_lots(known)
    if not scanned:
        log.warning("Главная страница вернула пустой список — сайт недоступен?")
        try:
            api_post("/save-daily-run", {"date": today, "lots_found": 0})
        except Exception as e:
            log.error(f"save-daily-run: {e}")
        return

    log.info(f"Новых лотов: {len(new_lots)} (просканировано {len(scanned)} из ленты)")
    for lot in new_lots:
        log.info(f"  + {lot['title'][:60]}  ({lot['price'] or 'без цены'})")

    all_ids = [lot["lot_id"] for lot in scanned]
    try:
        r = api_post("/add-lots", {"lot_ids": all_ids})
        log.info(f"add-lots: {r}")
    except Exception as e:
        log.error(f"add-lots: {e}")

    if new_lots:
        try:
            r = api_post("/save-daily-lots", {
                "date": today, "lots": new_lots, "ttl": cfg.GOSTORG_DAILY_TTL_SECONDS,
            })
            log.info(f"save-daily-lots: {r}")
        except Exception as e:
            log.error(f"save-daily-lots: {e}")
    else:
        log.info("Новых лотов нет.")

    try:
        r = api_post("/save-daily-run", {"date": today, "lots_found": len(new_lots)})
        log.info(f"save-daily-run: {r}")
    except Exception as e:
        log.error(f"save-daily-run: {e}")

    try:
        r = api_post("/send-notifications", {"date": today})
        log.info(f"send-notifications: {r}")
    except Exception as e:
        log.error(f"send-notifications: {e}")

    log.info("=== gostorg_daily.py завершён ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log.critical(f"Критическая ошибка: {e}", exc_info=True)
        sys.exit(1)
