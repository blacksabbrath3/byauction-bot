"""
rechitsa_lib.py — парсер rechitsa.by/ru/lenta_novostei-ru/

Структура страницы (из реального HTML):
  <a class="news_item hover_block ..."
     href="https://rechitsa.by/ru/lenta_novostei-ru/view/{slug}/"
     title="Заголовок новости">
    <span class="news_info">
      <span class="news_date ...">29.06.2026</span>
      <span class="news_title ...">Заголовок</span>
      <span ...>Краткий анонс...</span>
    </span>
  </a>
"""

import re
import time
import random
import logging
import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

BASE_URL = "https://rechitsa.by"
FEED_URL = f"{BASE_URL}/ru/lenta_novostei-ru/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9",
    "Referer":         BASE_URL,
}

_session = None


def _get_session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(HEADERS)
    return _session


def fetch_html(url: str) -> BeautifulSoup | None:
    time.sleep(random.uniform(1.5, 3.0))
    try:
        r = _get_session().get(url, timeout=25)
        r.raise_for_status()
        r.encoding = r.apparent_encoding or "windows-1251"
        return BeautifulSoup(r.text, "html.parser")
    except Exception as e:
        logger.error(f"fetch_html({url}): {e}")
        return None


def parse_feed_page(page_num: int = 1) -> list[dict]:
    """
    Парсит одну страницу ленты новостей.
    Возвращает список: {"url", "title", "date", "excerpt"}
    """
    url  = FEED_URL if page_num <= 1 else f"{FEED_URL}?PAGEN_1={page_num}"
    soup = fetch_html(url)
    if soup is None:
        return []

    items = []
    for a in soup.find_all("a", class_="news_item", href=True):
        href = a.get("href", "")
        if not href or "/lenta_novostei" not in href:
            continue
        if not href.startswith("http"):
            href = BASE_URL + href

        # Заголовок — из атрибута title (самый чистый)
        title = a.get("title", "").strip()
        if not title:
            el = a.select_one(".news_title")
            title = el.get_text(strip=True) if el else ""

        # Дата
        date_el = a.select_one(".news_date")
        date    = date_el.get_text(strip=True) if date_el else ""

        # Анонс — последний span в news_info, не дата и не заголовок
        excerpt = ""
        info = a.select_one(".news_info")
        if info:
            for sp in reversed(info.find_all("span", recursive=False)):
                cls = " ".join(sp.get("class", []))
                if "news_date" not in cls and "news_title" not in cls:
                    excerpt = sp.get_text(" ", strip=True)[:400]
                    break
            if not excerpt:
                raw = info.get_text(" ", strip=True)
                excerpt = re.sub(r"\s{2,}", " ",
                                 raw.replace(date, "").replace(title, "")).strip()[:400]

        items.append({
            "url":     href,
            "title":   title or "Без заголовка",
            "date":    date,
            "excerpt": excerpt,
        })

    logger.info(f"page {page_num}: {len(items)} articles")
    return items


def parse_article_details(url: str) -> dict:
    """Загружает полную страницу статьи."""
    soup = fetch_html(url)
    if soup is None:
        return {"title": "", "date": "", "full_text": "", "excerpt": ""}

    title = ""
    for sel in ["h1.news_view_title", "h1", ".page_title", "h2"]:
        el = soup.select_one(sel)
        if el:
            title = el.get_text(strip=True)
            if title:
                break

    date = ""
    date_el = soup.select_one(".news_date, .pub_date, time")
    if date_el:
        date = date_el.get_text(strip=True)

    body = (soup.select_one("div.news_view_text")
            or soup.select_one("div.fullstory")
            or soup.select_one("div.news-text")
            or soup.select_one("article"))
    full_text = body.get_text("\n", strip=True) if body else ""
    excerpt   = full_text[:500] + ("…" if len(full_text) > 500 else "")

    return {"title": title, "date": date, "full_text": full_text, "excerpt": excerpt}
