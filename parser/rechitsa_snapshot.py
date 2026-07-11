"""rechitsa_snapshot.py — первичный слепок ленты новостей rechitsa.by"""
import sys, logging, requests
import config as cfg
from rechitsa_lib import parse_feed_page

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [rechitsa_snapshot] %(levelname)s: %(message)s")
log = logging.getLogger(__name__)

WORKER_URL  = cfg.RECHITSA_WORKER_URL
API_KEY     = cfg.PARSER_SECRET
SNAPSHOT_LIMIT = 50
HEADERS = {"X-API-Key": API_KEY, "Content-Type": "application/json"}

def main():
    log.info("=== rechitsa_snapshot.py ===")
    if not WORKER_URL: log.error("RECHITSA_WORKER_URL не задан"); sys.exit(1)
    if not API_KEY:    log.error("PARSER_SECRET не задан");     sys.exit(1)

    log.info("Парсим первую страницу ленты…")
    items = parse_feed_page(page_num=1)
    if not items:
        log.error("Страница вернула пустой список — проверьте доступность сайта")
        sys.exit(1)

    urls = [it["url"] for it in items[:SNAPSHOT_LIMIT]]
    log.info(f"Получено {len(items)} новостей, сохраняем {len(urls)}")
    for u in urls:
        log.info(f"  {u}")

    try:
        r = requests.post(f"{WORKER_URL}/add-articles",
            json={"urls": urls}, headers=HEADERS, timeout=30)
        r.raise_for_status()
        log.info(f"Сохранено: {r.json()}")
    except Exception as e:
        log.error(f"Ошибка сохранения: {e}"); sys.exit(1)

    log.info("=== Снапшот завершён ===")

if __name__ == "__main__":
    main()
