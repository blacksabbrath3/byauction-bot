"""
rechitsa_daily.py — ежедневный парсер rechitsa.by новостной ленты

Алгоритм:
  1. GET /known-articles  → set известных URL
  2. Парсим /ru/lenta_novostei-ru/ постранично, стоп при STOP_AFTER_CONSECUTIVE_KNOWN подряд
  3. Загружаем полные страницы новых статей (заголовок + текст)
  4. POST /add-articles   → добавляем URL
  5. POST /save-daily-articles → сохраняем пачку
  6. POST /send-notifications  → рассылаем сразу
"""
import os, sys, time, logging, datetime, requests
import config as cfg
from rechitsa_lib import parse_feed_page, parse_article_details

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [rechitsa] %(levelname)s: %(message)s")
log = logging.getLogger(__name__)

WORKER_URL  = cfg.RECHITSA_WORKER_URL
API_KEY     = cfg.PARSER_SECRET
MAX_PAGES   = cfg.RECHITSA_MAX_PAGES
DELAY_ART   = cfg.RECHITSA_DELAY_BETWEEN_ARTICLES
DELAY_PAGE  = cfg.RECHITSA_DELAY_BETWEEN_PAGES
STOP_AFTER  = cfg.STOP_AFTER_CONSECUTIVE_KNOWN
HEADERS     = {"X-API-Key": API_KEY, "Content-Type": "application/json"}


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
        data = api_get("/known-articles")
        lst = data.get("articles", data if isinstance(data, list) else [])
        return set(lst)
    except Exception as e:
        log.error(f"load_known: {e}")
        return set()


def find_new(known: set[str]) -> list[dict]:
    new_items, consecutive = [], 0
    for page in range(1, MAX_PAGES + 1):
        items = parse_feed_page(page)
        if not items:
            log.warning(f"Страница {page} пуста — стоп")
            break
        for item in items:
            if item["url"] in known:
                consecutive += 1
                if consecutive >= STOP_AFTER:
                    log.info(f"{STOP_AFTER} известных подряд — стоп")
                    return new_items
            else:
                consecutive = 0
                new_items.append(item)
                log.info(f"  Новая: {item['title'][:60]}")
        if page < MAX_PAGES:
            time.sleep(DELAY_PAGE)
    log.info(f"Всего новых: {len(new_items)}")
    return new_items


def enrich(articles: list[dict]) -> list[dict]:
    result = []
    for i, item in enumerate(articles):
        log.info(f"[{i+1}/{len(articles)}] {item['url']}")
        det = parse_article_details(item["url"])
        result.append({
            "url":       item["url"],
            "title":     det["title"]   or item["title"],
            "date":      det["date"]    or item.get("date", ""),
            "excerpt":   det["excerpt"] or item.get("excerpt", ""),
            "full_text": det["full_text"],
        })
        if i < len(articles) - 1:
            time.sleep(DELAY_ART)
    return result


def random_delay():
    import random
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        return
    d = random.randint(0, cfg.RANDOM_DELAY_MAX_SECONDS)
    log.info(f"Задержка {d} сек")
    time.sleep(d)


def main():
    today = datetime.date.today().isoformat()
    log.info(f"=== rechitsa_daily.py, {today} ===")
    random_delay()

    known = load_known()
    log.info(f"Известных: {len(known)}")

    new_raw = find_new(known)
    if new_raw:
        articles = enrich(new_raw)
        try:
            r = api_post("/add-articles", {"urls": [a["url"] for a in articles]})
            log.info(f"add-articles: {r}")
        except Exception as e:
            log.error(f"add-articles: {e}")
        try:
            r = api_post("/save-daily-articles",
                         {"date": today, "articles": articles, "ttl": 86400})
            log.info(f"save-daily-articles: {r}")
        except Exception as e:
            log.error(f"save-daily-articles: {e}")
    else:
        log.info("Новых статей нет.")

    try:
        r = api_post("/send-notifications", {"date": today})
        log.info(f"send-notifications: {r}")
    except Exception as e:
        log.error(f"send-notifications: {e}")

    log.info("=== rechitsa_daily.py завершён ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log.critical(f"Критическая ошибка: {e}", exc_info=True)
        sys.exit(1)
