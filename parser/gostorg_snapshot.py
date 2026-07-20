"""gostorg_snapshot.py — первичный слепок gostorg.by

Сайт показывает только последние ~20 лотов на главной странице (без
пагинации), поэтому снапшот — это просто фиксация текущих верхних
карточек как "уже известных", чтобы daily-парсер не разослал их все
как новые при первом запуске.
"""
import sys, logging, requests
import config as cfg
from gostorg_lib import parse_listing

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [gostorg_snapshot] %(levelname)s: %(message)s")
log = logging.getLogger(__name__)

WORKER_URL = cfg.GOSTORG_WORKER_URL
API_KEY    = cfg.PARSER_SECRET
HEADERS    = {"X-API-Key": API_KEY, "Content-Type": "application/json"}


def main():
    log.info("=== gostorg_snapshot.py ===")
    if not WORKER_URL: log.error("GOSTORG_WORKER_URL не задан"); sys.exit(1)
    if not API_KEY:    log.error("PARSER_SECRET не задан");     sys.exit(1)

    log.info("Снимаем главную страницу…")
    lots = parse_listing()
    if not lots:
        log.error("Главная страница вернула пустой список — проверьте доступность сайта")
        sys.exit(1)

    ids = [lot["lot_id"] for lot in lots]
    log.info(f"Получено {len(ids)} лотов, сохраняем как известные")
    for lot in lots:
        log.info(f"  {lot['title'][:60]}")

    try:
        r = requests.post(f"{WORKER_URL}/snapshot",
            json={"snapshot": ids}, headers=HEADERS, timeout=30)
        r.raise_for_status()
        log.info(f"Сохранено: {r.json()}")
    except Exception as e:
        log.error(f"Ошибка сохранения: {e}"); sys.exit(1)

    log.info("=== Снапшот завершён ===")


if __name__ == "__main__":
    main()
