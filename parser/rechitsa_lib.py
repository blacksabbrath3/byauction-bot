"""
rechitsa_lib.py — HTTP и парсинг HTML для rechitsa.by/gosim
Кодировка сайта: windows-1251
"""

import re
import time
import random
import logging
import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

BASE_URL = "https://rechitsa.by"
GOSIM_URL = f"{BASE_URL}/gosim"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
}

_session = None


def get_session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(HEADERS)
    return _session


def fetch_html(url: str, delay_min: float = 2.0, delay_max: float = 5.0) -> BeautifulSoup | None:
    """Загружает страницу и возвращает BeautifulSoup (windows-1251)."""
    time.sleep(random.uniform(delay_min, delay_max))
    try:
        r = get_session().get(url, timeout=20)
        r.raise_for_status()
        r.encoding = "windows-1251"
        return BeautifulSoup(r.text, "html.parser")
    except Exception as e:
        logger.error(f"fetch_html error {url}: {e}")
        return None


# ---------------------------------------------------------------------------
# Парсинг страницы-списка /gosim  (и /gosim/page/N/)
# ---------------------------------------------------------------------------

def parse_gosim_page(page_num: int = 1) -> list[dict]:
    """
    Парсит одну страницу списка.
    Возвращает список:
      {"url": "https://rechitsa.by/gosim/...", "title": "...", "date": "...", "preview": "..."}
    """
    if page_num == 1:
        url = GOSIM_URL
    else:
        url = f"{GOSIM_URL}/page/{page_num}/"

    soup = fetch_html(url)
    if soup is None:
        return []

    items = []

    # Новости лежат внутри основного контентного блока.
    # Каждая новость — блок вида:
    #   <div class="news-item"> (или аналогичный) с датой, заголовком-ссылкой, превью
    # Поскольку сайт на DLE, ищем стандартные блоки новостей.
    # Пробуем несколько вариантов селекторов.

    # Вариант 1: DLE стандартный шаблон — div с классом содержащим "news"
    news_blocks = soup.select("div.news-item, div.story, article.news, div[id^='newsitem']")

    # Вариант 2: таблицы (судя по web_fetch — новости идут как <table> блоки)
    if not news_blocks:
        # На странице каждая новость в отдельной таблице с датой и ссылкой [Подробнее..]
        # Ищем все ссылки с текстом "Подробнее"
        news_blocks = _parse_by_podrobnee_links(soup)
        return news_blocks

    results = []
    for block in news_blocks:
        item = _extract_item_from_block(block)
        if item:
            results.append(item)
    return results


def _parse_by_podrobnee_links(soup: BeautifulSoup) -> list[dict]:
    """
    Запасной парсер: ищет ссылки [Подробнее..] и извлекает контекст вокруг них.
    Работает с табличной вёрсткой DLE как на rechitsa.by.
    """
    items = []
    seen_urls = set()

    # Ищем все ссылки ведущие на /gosim/*.html
    for a in soup.find_all("a", href=re.compile(r"/gosim/\d+-[^/]+\.html")):
        href = a.get("href", "")
        if not href:
            continue
        # Абсолютный URL
        if href.startswith("http"):
            full_url = href
        else:
            full_url = BASE_URL + href

        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)

        # Текст ссылки — это либо заголовок, либо "Подробнее.."
        link_text = a.get_text(strip=True)

        # Ищем родительский контейнер (таблицу/div) с датой и текстом
        container = a
        for _ in range(6):  # идём вверх до 6 уровней
            container = container.parent
            if container is None:
                break
            container_text = container.get_text(separator=" ", strip=True)
            # Признак контейнера новости: содержит дату в формате "DD месяц YYYY"
            if re.search(r"\d{1,2}\s+\w+\s+\d{4}", container_text):
                break

        if container is None:
            continue

        container_text = container.get_text(separator=" ", strip=True)

        # Извлекаем дату
        date_match = re.search(
            r"(\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|"
            r"июля|августа|сентября|октября|ноября|декабря)\s+\d{4})",
            container_text,
            re.IGNORECASE,
        )
        date_str = date_match.group(1) if date_match else ""

        # Тип/заголовок: первый крупный текст в контейнере до ссылки
        # Обычно: "Извещение", "Информационное сообщение", "Проектная декларация"
        title = _extract_title_from_container(container, full_url)

        # Превью — текст контейнера без даты и "Подробнее"
        preview = _extract_preview(container_text, date_str, title)

        items.append({
            "url": full_url,
            "title": title or "Без заголовка",
            "date": date_str,
            "preview": preview,
        })

    return items


def _extract_title_from_container(container, url: str) -> str:
    """
    Пытается извлечь заголовок/тип из контейнера новости.
    Приоритет: жирный текст → первая строка → slug из URL.
    """
    # Ищем жирный текст (заголовок типа новости)
    for tag in container.find_all(["b", "strong", "h2", "h3", "h4"]):
        text = tag.get_text(strip=True)
        if text and len(text) > 3 and "Подробнее" not in text:
            return text

    # Fallback: берём slug из URL и делаем его читаемым
    slug_match = re.search(r"/gosim/\d+-(.+?)\.html", url)
    if slug_match:
        slug = slug_match.group(1).replace("-", " ").capitalize()
        return slug

    return ""


def _extract_preview(full_text: str, date: str, title: str) -> str:
    """Убирает дату, заголовок и 'Подробнее' из текста, возвращает превью."""
    text = full_text
    if date:
        text = text.replace(date, "")
    if title:
        text = text.replace(title, "")
    text = re.sub(r"Подробнее\.{0,2}", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text[:300] if text else ""


def _extract_item_from_block(block) -> dict | None:
    """Извлекает данные новости из стандартного DLE-блока."""
    a = block.find("a", href=re.compile(r"/gosim/\d+"))
    if not a:
        return None
    href = a.get("href", "")
    url = href if href.startswith("http") else BASE_URL + href
    title = a.get_text(strip=True)
    date = ""
    date_tag = block.find(class_=re.compile(r"date|time", re.I))
    if date_tag:
        date = date_tag.get_text(strip=True)
    preview = block.get_text(separator=" ", strip=True)[:300]
    return {"url": url, "title": title, "date": date, "preview": preview}


# ---------------------------------------------------------------------------
# Парсинг полной страницы статьи
# ---------------------------------------------------------------------------

def parse_article_details(url: str) -> dict:
    """
    Загружает полную страницу статьи и возвращает:
      {"title": "...", "date": "...", "full_text": "...", "excerpt": "..."}
    excerpt — обрезанный full_text до 500 символов.
    """
    soup = fetch_html(url)
    if soup is None:
        return {"title": "", "date": "", "full_text": "", "excerpt": ""}

    # Заголовок — h1 или первый крупный тег
    title = ""
    for tag in soup.find_all(["h1", "h2"]):
        t = tag.get_text(strip=True)
        if t and len(t) > 3:
            title = t
            break

    # Дата публикации
    date = ""
    date_match = re.search(
        r"(\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|"
        r"июля|августа|сентября|октября|ноября|декабря)\s+\d{4})",
        soup.get_text(),
        re.IGNORECASE,
    )
    if date_match:
        date = date_match.group(1)

    # Основной текст статьи
    # DLE кладёт контент в div с классами fullstory, fullnews, story, postbody и т.п.
    content_div = (
        soup.select_one("div.fullstory")
        or soup.select_one("div.fullnews")
        or soup.select_one("div.story-full")
        or soup.select_one("div[id='news-content']")
        or soup.select_one("div.postbody")
    )

    if content_div:
        full_text = content_div.get_text(separator="\n", strip=True)
    else:
        # Fallback: берём основной контент страницы без навигации/футера
        # Убираем типичные шумовые блоки
        for noise in soup.select("header, footer, nav, .menu, .sidebar, script, style"):
            noise.decompose()
        full_text = soup.get_text(separator="\n", strip=True)
        # Обрезаем до начала навигационных ссылок в конце
        full_text = _clean_article_text(full_text)

    excerpt = full_text[:500].strip()
    if len(full_text) > 500:
        excerpt += "…"

    return {
        "title": title,
        "date": date,
        "full_text": full_text,
        "excerpt": excerpt,
    }


def _clean_article_text(text: str) -> str:
    """Убирает типичный мусор навигации из извлечённого текста страницы."""
    lines = text.splitlines()
    clean = []
    stop_markers = [
        "COPYRIGHT ©",
        "Яндекс.Метрика",
        "Просмотров:",
        "Добавил:",
        "Распечатать",
        "Поделиться",
    ]
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if any(m in line for m in stop_markers):
            break
        clean.append(line)
    return "\n".join(clean)


# ---------------------------------------------------------------------------
# Определение числа страниц в /gosim
# ---------------------------------------------------------------------------

def get_total_pages() -> int:
    """Читает пагинацию на первой странице и возвращает общее число страниц."""
    soup = fetch_html(GOSIM_URL, delay_min=1, delay_max=2)
    if soup is None:
        return 1
    # Ищем ссылки пагинации вида /gosim/page/N/
    page_nums = [1]
    for a in soup.find_all("a", href=re.compile(r"/gosim/page/(\d+)/")):
        m = re.search(r"/page/(\d+)/", a["href"])
        if m:
            page_nums.append(int(m.group(1)))
    return max(page_nums)
