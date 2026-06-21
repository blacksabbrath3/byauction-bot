"""
rechitsa_daily.py — ежедневный парсер rechitsa.by/gosim

Алгоритм:
1. GET /rechitsa/known-articles  →  список известных URL (новые первыми)
2. Парсим страницы /gosim постранично, пока не встретим уже известный URL
3. Для каждого нового URL загружаем полную страницу статьи
4. POST /rechitsa/add-articles  →  добавляем новые URL в known-articles
5. POST /rechitsa/save-daily-articles  →  сохраняем суточную пачку с деталями
6. POST /rechitsa/send-notifications  →  рассылаем уведомления подписчикам сразу
"""

import os
import sys
import time
import logging
import datetime
import requests

from rechitsa_lib import (
    parse_gosim_page,
    parse_article_details,
    get_total_pages,
    GOSIM_URL,
)

# ---------------------------------------------------------------------------
# Конфигурация
# ---------------------------------------------------------------------------

import config as cfg

WORKER_URL             = cfg.RECHITSA_WORKER_URL
API_KEY                = cfg.PARSER_SECRET
DELAY_BETWEEN_ARTICLES = cfg.RECHITSA_DELAY_BETWEEN_ARTICLES
DELAY_BETWEEN_PAGES    = cfg.RECHITSA_DELAY_BETWEEN_PAGES
MAX_PAGES_TO_SCAN      = cfg.RECHITSA_MAX_PAGES
ARTICLE_TEXT_LIMIT     = cfg.RECHITSA_ARTICLE_TEXT_LIMIT

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [rechitsa] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

API_HEADERS = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json",
}


# ---------------------------------------------------------------------------
# Обращения к Worker API
# ---------------------------------------------------------------------------

def api_get(path: str) -> dict:
    r = requests.get(f"{WORKER_URL}{path}", headers=API_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def api_post(path: str, body: dict) -> dict:
    r = requests.post(f"{WORKER_URL}{path}", json=body, headers=API_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Основная логика
# ---------------------------------------------------------------------------

def load_known_articles() -> set[str]:
    """Загружает список известных URL из Worker KV."""
    try:
        data = api_get("/known-articles")
        return set(data.get("articles", []))
    except Exception as e:
        log.error(f"load_known_articles: {e}")
        return set()


def find_new_articles(known: set[str]) -> list[dict]:
    """
    Парсит страницы /gosim, собирает новые статьи (которых нет в known).
    Останавливается когда встречает известную статью или достигает MAX_PAGES_TO_SCAN.
    Возвращает список dict с url, title, date (без full_text — он грузится отдельно).
    """
    new_articles = []
    found_boundary = False

    for page in range(1, MAX_PAGES_TO_SCAN + 1):
        log.info(f"Сканируем страницу {page} списка /gosim")
        items = parse_gosim_page(page)

        if not items:
            log.warning(f"Страница {page} вернула пустой список, останавливаемся")
            break

        for item in items:
            if item["url"] in known:
                log.info(f"Найдена граница: {item['url']}")
                found_boundary = True
                break
            new_articles.append(item)

        if found_boundary:
            break

        # Если ни один из этой страницы не известен — возможно это первый запуск,
        # продолжаем сканирование
        time.sleep(DELAY_BETWEEN_PAGES)

    log.info(f"Найдено новых статей: {len(new_articles)}")
    return new_articles


def enrich_articles(articles: list[dict]) -> list[dict]:
    """
    Для каждой новой статьи загружает полную страницу и добавляет full_text / excerpt.
    """
    enriched = []
    for i, item in enumerate(articles):
        log.info(f"[{i+1}/{len(articles)}] Загружаем детали: {item['url']}")
        details = parse_article_details(item["url"])

        # Предпочитаем заголовок с полной страницы, если он лучше
        title = details["title"] or item["title"] or "Без заголовка"
        date  = details["date"] or item.get("date", "")

        enriched.append({
            "url":      item["url"],
            "title":    title,
            "date":     date,
            "excerpt":  details["excerpt"],
            "full_text": details["full_text"],
        })

        if i < len(articles) - 1:
            time.sleep(DELAY_BETWEEN_ARTICLES)

    return enriched


def save_to_worker(new_articles: list[dict], today: str) -> None:
    """Сохраняет новые URL и суточную пачку в KV через Worker API."""

    # 1. Добавляем новые пути в known_articles
    new_urls = [a["url"] for a in new_articles]
    try:
        api_post("/add-articles", {"urls": new_urls})
        log.info(f"Добавлено в known_articles: {len(new_urls)}")
    except Exception as e:
        log.error(f"add-articles error: {e}")

    # 2. Сохраняем суточную пачку (TTL 1 день)
    try:
        api_post("/save-daily-articles", {
            "date":     today,
            "articles": new_articles,
            "ttl":      86400,
        })
        log.info("Суточная пачка сохранена")
    except Exception as e:
        log.error(f"save-daily-articles error: {e}")


def send_notifications(today: str) -> None:
    """Запускает рассылку уведомлений через Worker."""
    try:
        result = api_post("/send-notifications", {"date": today})
        log.info(f"Рассылка завершена: {result}")
    except Exception as e:
        log.error(f"send-notifications error: {e}")


# ---------------------------------------------------------------------------
# Точка входа
# ---------------------------------------------------------------------------

def random_delay() -> None:
    """Случайная задержка. Пропускается при SKIP_RANDOM_DELAY=true."""
    import random
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        log.info("Рандомная задержка пропущена (ручной запуск).")
        return
    delay = random.randint(0, cfg.RANDOM_DELAY_MAX_SECONDS)
    log.info(f"Рандомная задержка: {delay} сек ({delay // 60} мин)")
    time.sleep(delay)


def main() -> None:
    today = datetime.date.today().isoformat()
    log.info(f"=== Запуск rechitsa_daily.py, дата: {today} ===")

    # 0. Рандомная задержка (пропускается при ручном запуске)
    random_delay()

    # 1. Загружаем известные URL
    known = load_known_articles()
    log.info(f"Известных статей: {len(known)}")

    # 2. Ищем новые
    new_raw = find_new_articles(known)

    if not new_raw:
        log.info("Новых статей не найдено")
    else:
        # 3. Загружаем детали
        new_articles = enrich_articles(new_raw)

        # 4. Сохраняем в KV
        save_to_worker(new_articles, today)

    # 5. Рассылаем уведомления сразу (расписание само контролирует время старта)
    send_notifications(today)

    # 7. Сохраняем дату последнего запуска
    try:
        r = api_post("/save-daily-run", {
            "date":       today,
            "lots_found": len(new_raw) if new_raw else 0,
        })
        log.info(f"/save-daily-run: {r}")
    except Exception as e:
        log.warning(f"/save-daily-run failed: {e}")

    log.info("=== rechitsa_daily.py завершён ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log.critical(f"Критическая ошибка: {e}", exc_info=True)
        sys.exit(1)
