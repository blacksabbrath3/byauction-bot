"""
rechitsa_snapshot.py — первичный слепок rechitsa.by новостной ленты

Алгоритм:
  1. Парсит первую страницу /ru/lenta_novostei-ru/ (самые свежие новости)
  2. Берёт первые SNAPSHOT_LIMIT URL (50 по умолчанию)
  3. POST /add-articles → сохраняет URL в known_articles в KV

Запускается один раз вручную перед первым запуском ежедневного парсера.
"""

import sys
import logging
import requests

import config as cfg
from rechitsa_lib import parse_feed_page, FEED_URL

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [rechitsa_snapshot] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

WORKER_URL     = cfg.RECHITSA_WORKER_URL
API_KEY        = cfg.PARSER_SECRET
SNAPSHOT_LIMIT = 50

API_HEADERS = {"X-API-Key": API_KEY, "Content-Type": "application/json"}


def fetch_latest_urls() -> list[str]:
    log.info(f"Парсим ленту: {FEED_URL}")
    items = parse_feed_page(page_num=1)
    if not items:
        log.error("Страница вернула пустой список — проверьте доступность сайта")
        sys.exit(1)
    urls = [item["url"] for item in items[:SNAPSHOT_LIMIT]]
    log.info(f"Получено {len(items)} новостей, берём первые {len(urls)}")
    for url in urls:
        log.info(f"  {url}")
    return urls


def save_snapshot(urls: list[str]) -> None:
    try:
        r = requests.post(
            f"{WORKER_URL}/add-articles",
            json={"urls": urls},
            headers=API_HEADERS,
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        log.info(f"Сохранено: добавлено {data.get('added')}, всего {data.get('total')}")
    except Exception as e:
        log.error(f"Ошибка сохранения: {e}")
        sys.exit(1)


def main() -> None:
    log.info("=== rechitsa_snapshot.py ===")
    if not WORKER_URL:
        log.error("RECHITSA_WORKER_URL не задан"); sys.exit(1)
    if not API_KEY:
        log.error("PARSER_SECRET не задан"); sys.exit(1)

    urls = fetch_latest_urls()
    save_snapshot(urls)
    log.info("=== Снапшот завершён ===")


if __name__ == "__main__":
    main()
