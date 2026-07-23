"""
beltorgi_daily.py — ежедневный парсер beltorgi.by

Главная страница не гарантирует порядок "новые сверху" (виджеты
вперемешку) и содержит дубли карточек — поэтому, в отличие от gostorg,
здесь просто сравнивается ВЕСЬ дедуплицированный снятый набор со списком
известных id, без покарточной остановки после N известных подряд.

  1. GET /known-lots           → set известных lot_id
  2. Снимаем и дедуплицируем карточки с главной страницы
  3. Новые — те, кого нет среди известных
  4. POST /add-lots             → добавляем ВСЕ увиденные id
  5. POST /save-daily-lots      → сохраняем пачку новых лотов (если есть)
  6. POST /save-daily-run       → отмечаем время запуска
  7. POST /send-notifications   → рассылаем сразу
"""
import os, sys, time, random, logging, datetime, requests
import config as cfg
from beltorgi_lib import parse_listing

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [beltorgi] %(levelname)s: %(message)s")
log = logging.getLogger(__name__)

WORKER_URL = cfg.BELTORGI_WORKER_URL
API_KEY    = cfg.PARSER_SECRET
HEADERS    = {"X-API-Key": API_KEY, "Content-Type": "application/json"}


def api_get(path):
    r = requests.get(f"{WORKER_URL}{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def api_post(path, body):
    r = requests.post(f"{WORKER_URL}{path}", json=body, headers=HEADERS, timeout=30)
    try:
        r.raise_for_status()
    except requests.HTTPError:
        log.error(f"  ответ сервера: {r.text[:300]}")
        raise
    return r.json()


def load_known() -> set[str]:
    try:
        data = api_get("/known-lots")
        return set(str(x) for x in (data or []))
    except Exception as e:
        log.error(f"load_known: {e}")
        return set()


def random_delay():
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        return
    d = random.randint(0, cfg.RANDOM_DELAY_MAX_SECONDS)
    log.info(f"Задержка {d} сек")
    time.sleep(d)


def main():
    today = datetime.date.today().isoformat()
    log.info(f"=== beltorgi_daily.py, {today} ===")

    if not WORKER_URL: log.error("BELTORGI_WORKER_URL не задан"); sys.exit(1)
    if not API_KEY:    log.error("PARSER_SECRET не задан");      sys.exit(1)

    random_delay()

    known = load_known()
    log.info(f"Известных лотов: {len(known)}")

    time.sleep(random.uniform(cfg.BELTORGI_DELAY_MIN, cfg.BELTORGI_DELAY_MAX))
    lots = parse_listing()
    if not lots:
        log.warning("Главная страница вернула пустой список — сайт недоступен?")
        try:
            api_post("/save-daily-run", {"date": today, "lots_found": 0})
        except Exception as e:
            log.error(f"save-daily-run: {e}")
        return

    new_lots = [lot for lot in lots if lot["lot_id"] not in known]
    auc  = sum(1 for l in new_lots if l["is_auction"])
    shop = len(new_lots) - auc
    log.info(f"Новых лотов: {len(new_lots)} из {len(lots)} снятых (аукцион: {auc}, магазин: {shop})")
    for lot in new_lots:
        log.info(f"  + {lot['title'][:60]}  ({lot['price'] or 'без цены'})")

    all_ids = [lot["lot_id"] for lot in lots]
    try:
        r = api_post("/add-lots", {"lot_ids": all_ids})
        log.info(f"add-lots: {r}")
    except Exception as e:
        log.error(f"add-lots: {e}")

    if new_lots:
        try:
            r = api_post("/save-daily-lots", {
                "date": today, "lots": new_lots, "ttl": cfg.BELTORGI_DAILY_TTL_SECONDS,
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

    log.info("=== beltorgi_daily.py завершён ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log.critical(f"Критическая ошибка: {e}", exc_info=True)
        sys.exit(1)
