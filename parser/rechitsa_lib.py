"""
rechitsa_lib.py — HTTP и парсинг HTML для rechitsa.by/ru/lenta_novostei-ru/

Сайт работает на DLE (Data Life Engine), кодировка windows-1251.
Лента новостей: https://rechitsa.by/ru/lenta_novostei-ru/
Пагинация:      https://rechitsa.by/ru/lenta_novostei-ru/page/2/  (и т.д.)
"""

import re
import time
import random
import logging
import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

BASE_URL  = "https://rechitsa.by"
FEED_URL  = f"{BASE_URL}/ru/lenta_novostei-ru/"
FEED_PATH = "/ru/lenta_novostei-ru/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
}

_session = None


def get_session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(HEADERS)
    return _session


def fetch_html(url: str, delay_min: float = 1.5, delay_max: float = 3.5) -> BeautifulSoup | None:
    """Загружает страницу и возвращает BeautifulSoup (windows-1251)."""
    time.sleep(random.uniform(delay_min, delay_max))
    try:
        r = get_session().get(url, timeout=25)
        r.raise_for_status()
        r.encoding = "windows-1251"
        return BeautifulSoup(r.text, "html.parser")
    except Exception as e:
        logger.error(f"fetch_html error {url}: {e}")
        return None


# ─────────────────────────────────────────────────────────────
# Парсинг ленты новостей
# ─────────────────────────────────────────────────────────────

# Паттерн для ссылок на статьи ленты новостей
# Типичный DLE-URL: /ru/lenta_novostei-ru/12345-zagolovok.html
_ARTICLE_HREF_RE = re.compile(r"/ru/lenta_novostei-ru/\d+-[^/\"']+\.html")

_MONTHS_RU = (
    "января|февраля|марта|апреля|мая|июня|"
    "июля|августа|сентября|октября|ноября|декабря"
)
_DATE_RE = re.compile(
    r"(\d{1,2}\s+(?:" + _MONTHS_RU + r")\s+\d{4})",
    re.IGNORECASE,
)


def parse_feed_page(page_num: int = 1) -> list[dict]:
    """
    Парсит одну страницу новостной ленты.
    Возвращает список:
      {"url": "https://...", "title": "...", "date": "...", "excerpt": "..."}
    """
    if page_num == 1:
        url = FEED_URL
    else:
        url = f"{FEED_URL}page/{page_num}/"

    soup = fetch_html(url)
    if soup is None:
        return []

    # Стратегия 1: стандартные DLE-блоки с классом news-item, story и т.п.
    blocks = soup.select(
        "div.news-item, div.story, article.news, "
        "div[id^='newsitem'], div.news, div.article-item"
    )
    if blocks:
        results = [r for b in blocks for r in [_item_from_block(b, soup)] if r]
        if results:
            return results

    # Стратегия 2: ищем все ссылки на статьи ленты и строим элементы вокруг них
    return _items_from_links(soup)


def _item_from_block(block, soup) -> dict | None:
    """Извлекает элемент новости из DLE-блока."""
    a = block.find("a", href=_ARTICLE_HREF_RE)
    if not a:
        return None
    href = a.get("href", "")
    url  = href if href.startswith("http") else BASE_URL + href
    title = a.get_text(strip=True) or _title_from_url(href)
    text  = block.get_text(separator=" ", strip=True)
    date  = _extract_date(text)
    excerpt = _clean_excerpt(text, title, date)
    return {"url": url, "title": title, "date": date, "excerpt": excerpt}


def _items_from_links(soup: BeautifulSoup) -> list[dict]:
    """Запасной парсер: ищет все ссылки на статьи ленты новостей."""
    items    = []
    seen_urls = set()

    for a in soup.find_all("a", href=_ARTICLE_HREF_RE):
        href = a.get("href", "")
        if not href:
            continue
        url = href if href.startswith("http") else BASE_URL + href
        if url in seen_urls:
            continue
        seen_urls.add(url)

        link_text = a.get_text(strip=True)

        # Ищем контейнер с датой поднимаясь вверх по дереву
        container = a
        for _ in range(7):
            container = container.parent
            if container is None:
                break
            if _DATE_RE.search(container.get_text()):
                break

        if container is None:
            container = a

        container_text = container.get_text(separator=" ", strip=True)
        date  = _extract_date(container_text)
        title = _extract_title(container, url, link_text)
        excerpt = _clean_excerpt(container_text, title, date)

        items.append({
            "url":     url,
            "title":   title or "Без заголовка",
            "date":    date,
            "excerpt": excerpt,
        })

    return items


def _extract_date(text: str) -> str:
    m = _DATE_RE.search(text)
    return m.group(1) if m else ""


def _extract_title(container, url: str, link_text: str) -> str:
    # Предпочитаем явный заголовочный тег
    for tag in container.find_all(["h1", "h2", "h3", "b", "strong"]):
        t = tag.get_text(strip=True)
        if t and len(t) > 4 and "Подробнее" not in t:
            return t
    # Если текст ссылки информативен — используем его
    if link_text and "Подробнее" not in link_text and len(link_text) > 4:
        return link_text
    # Fallback: slug из URL
    return _title_from_url(url)


def _title_from_url(url: str) -> str:
    m = re.search(r"/\d+-(.+?)\.html", url)
    if m:
        return m.group(1).replace("-", " ").capitalize()
    return ""


def _clean_excerpt(text: str, title: str, date: str) -> str:
    """Убирает заголовок, дату и «Подробнее» из текста, возвращает краткое описание."""
    for remove in [date, title]:
        if remove:
            text = text.replace(remove, "", 1)
    text = re.sub(r"Подробнее\.{0,3}", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text[:400] if text else ""


# ─────────────────────────────────────────────────────────────
# Парсинг полной страницы статьи
# ─────────────────────────────────────────────────────────────

def parse_article_details(url: str) -> dict:
    """
    Загружает полную страницу статьи.
    Возвращает: {"title", "date", "excerpt", "full_text"}
    """
    soup = fetch_html(url)
    if soup is None:
        return {"title": "", "date": "", "full_text": "", "excerpt": ""}

    # Заголовок
    title = ""
    for tag in soup.find_all(["h1", "h2"]):
        t = tag.get_text(strip=True)
        if t and len(t) > 3:
            title = t
            break

    # Дата
    date = _extract_date(soup.get_text())

    # Основной текст (DLE-классы)
    content = (
        soup.select_one("div.fullstory")
        or soup.select_one("div.fullnews")
        or soup.select_one("div.story-full")
        or soup.select_one("div#news-content")
        or soup.select_one("div.postbody")
        or soup.select_one("div.article-body")
        or soup.select_one("div.content")
    )
    if content:
        full_text = content.get_text(separator="\n", strip=True)
    else:
        for noise in soup.select("header, footer, nav, .menu, .sidebar, script, style"):
            noise.decompose()
        full_text = _clean_article_text(soup.get_text(separator="\n", strip=True))

    excerpt = full_text[:500].strip()
    if len(full_text) > 500:
        excerpt += "…"

    return {"title": title, "date": date, "full_text": full_text, "excerpt": excerpt}


def _clean_article_text(text: str) -> str:
    lines = text.splitlines()
    clean = []
    stop = ["COPYRIGHT ©", "Яндекс.Метрика", "Просмотров:", "Добавил:", "Распечатать", "Поделиться"]
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if any(s in line for s in stop):
            break
        clean.append(line)
    return "\n".join(clean)
