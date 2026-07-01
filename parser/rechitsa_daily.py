"""
rechitsa_daily.py — ежедневный парсер rechitsa.by новостной ленты

Алгоритм:
  1. GET /known-articles         → set известных URL
  2. Парсим ленту /ru/lenta_novostei-ru/ постранично,
     останавливаемся при STOP_AFTER_CONSECUTIVE_KNOWN известных URL подряд
  3. Для каждой новой новости загружаем полную страницу (заголовок + текст)
  4. POST /add-articles          → добавляем новые URL
  5. POST /save-daily-articles   → сохраняем суточную пачку
  6. POST /send-notifications    → рассылаем сразу (без ожидания)

Ключевые слова: пользователь задаёт их в боте — воркер фильтрует
совпадения по заголовку + тексту новости через matchKeywords.
"""

import os
import sys
import time
import logging
import datetime
import requests

from rechitsa_lib import parse_feed_page, parse_article_details, FEED_URL

import config as cfg

# ─────────────────────────────────────────────────────────────
# Конфигурация
# ─────────────────────────────────────────────────────────────

WORKER_URL             = cfg.RECHITSA_WORKER_URL
API_KEY                = cfg.PARSER_SECRET
DELAY_BETWEEN_ARTICLES = cfg.RECHITSA_DELAY_BETWEEN_ARTICLES
DELAY_BETWEEN_PAGES    = cfg.RECHITSA_DELAY_BETWEEN_PAGES
MAX_PAGES_TO_SCAN      = cfg.RECHITSA_MAX_PAGES
STOP_AFTER_CONSECUTIVE = cfg.STOP_AFTER_CONSECUTIVE_KNOWN

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [rechitsa] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

API_HEADERS = {"X-API-Key": API_KEY, "Content-Type": "application/json"}


# ─────────────────────────────────────────────────────────────
# Worker API
# ─────────────────────────────────────────────────────────────

def api_get(path: str) -> dict:
    r = requests.get(f"{WORKER_URL}{path}", headers=API_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def api_post(path: str, body: dict) -> dict:
    r = requests.post(f"{WORKER_URL}{path}", json=body, headers=API_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


# ─────────────────────────────────────────────────────────────
# Основная логика
# ─────────────────────────────────────────────────────────────

def load_known_articles() -> set[str]:
    try:
        data = api_get("/known-articles")
        ids = data.get("articles", data if isinstance(data, list) else [])
        return set(ids)
    except Exception as e:
        log.error(f"load_known_articles: {e}")
        return set()


def find_new_articles(known: set[str]) -> list[dict]:
    """
    Парсит страницы ленты, собирает новые статьи.
    Останавливается при STOP_AFTER_CONSECUTIVE_KNOWN известных подряд.
    """
    new_articles = []
    consecutive_known = 0

    for page in range(1, MAX_PAGES_TO_SCAN + 1):
        log.info(f"Сканируем страницу {page}: {FEED_URL}")
        items = parse_feed_page(page)

        if not items:
            log.warning(f"Страница {page} пуста — останавливаемся")
            break

        page_had_new = False
        for item in items:
            if item["url"] in known:
                consecutive_known += 1
                log.debug(f"Известная: {item['url']} (consecutive={consecutive_known})")
                if consecutive_known >= STOP_AFTER_CONSECUTIVE:
                    log.info(f"Встретили {STOP_AFTER_CONSECUTIVE} известных подряд — стоп")
                    return new_articles
            else:
                consecutive_known = 0
                new_articles.append(item)
                page_had_new = True
                log.info(f"  Новая: {item['url']}")

        # Если вся страница состоит из известных — дальше не идём
        if not page_had_new and page > 1:
            log.info("Вся страница из известных — останавливаемся")
            break

        if page < MAX_PAGES_TO_SCAN:
            time.sleep(DELAY_BETWEEN_PAGES)

    log.info(f"Найдено новых статей: {len(new_articles)}")
    return new_articles


def enrich_articles(articles: list[dict]) -> list[dict]:
    """Загружает полные страницы новых статей для получения полного текста."""
    enriched = []
    for i, item in enumerate(articles):
        log.info(f"[{i+1}/{len(articles)}] Загружаем: {item['url']}")
        details = parse_article_details(item["url"])

        enriched.append({
            "url":      item["url"],
            "title":    details["title"] or item["title"] or "Без заголовка",
            "date":     details["date"]  or item.get("date", ""),
            "excerpt":  details["excerpt"] or item.get("excerpt", ""),
            "full_text": details["full_text"],
        })

        if i < len(articles) - 1:
            time.sleep(DELAY_BETWEEN_ARTICLES)

    return enriched


def save_to_worker(articles: list[dict], today: str) -> None:
    new_urls = [a["url"] for a in articles]
    try:
        r = api_post("/add-articles", {"urls": new_urls})
        log.info(f"add-articles: {r}")
    except Exception as e:
        log.error(f"add-articles error: {e}")

    try:
        r = api_post("/save-daily-articles", {
            "date": today, "articles": articles, "ttl": 86400,
        })
        log.info(f"save-daily-articles: {r}")
    except Exception as e:
        log.error(f"save-daily-articles error: {e}")


def send_notifications(today: str) -> None:
    try:
        r = api_post("/send-notifications", {"date": today})
        log.info(f"send-notifications: {r}")
    except Exception as e:
        log.error(f"send-notifications error: {e}")


def random_delay() -> None:
    import random
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        log.info("Рандомная задержка пропущена (ручной запуск).")
        return
    delay = random.randint(0, cfg.RANDOM_DELAY_MAX_SECONDS)
    log.info(f"Рандомная задержка: {delay} сек ({delay // 60} мин)")
    time.sleep(delay)


# ─────────────────────────────────────────────────────────────
# Точка входа
# ─────────────────────────────────────────────────────────────

def main() -> None:
    today = datetime.date.today().isoformat()
    log.info(f"=== rechitsa_daily.py, дата: {today} ===")
    log.info(f"Лента: {FEED_URL}")

    random_delay()

    known = load_known_articles()
    log.info(f"Известных URL: {len(known)}")

    new_raw = find_new_articles(known)

    if new_raw:
        new_articles = enrich_articles(new_raw)
        save_to_worker(new_articles, today)
    else:
        log.info("Новых статей нет.")

    # Рассылаем сразу — расписание само контролирует время
    send_notifications(today)

    log.info("=== rechitsa_daily.py завершён ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log.critical(f"Критическая ошибка: {e}", exc_info=True)
        sys.exit(1)
