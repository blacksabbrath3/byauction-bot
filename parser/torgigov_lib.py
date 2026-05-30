"""
torgigov_lib.py — общие функции парсера torgi.gov.by

Структура сайта:
  Каталог:   https://torgi.gov.by/catalog/{slug}/{page}/?category={id}
  Лот:       https://torgi.gov.by/lot/{lot_id}/{auction_id}/

Важно: сайт — Angular SPA. Живой сервер отдаёт почти пустой HTML,
весь контент (включая меню категорий) рендерится JavaScript'ом.
Категории поэтому хардкодируются в TOP_CATEGORIES и обновляются
вручную при изменении структуры сайта.

Таблицы на странице лота (серверный рендеринг, парсится нормально):
  .detail_lot_part1   — Наименование, Категория, Регион, Местонахождение
  .detail_lot_part2   — Начальная цена единицы
"""

import re
import time
import random
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, unquote

import config as cfg

BASE_URL = "https://torgi.gov.by"

# ════════════════════════════════════════════════════════════
# TOP-LEVEL КАТЕГОРИИ — хардкод из реального меню сайта
# (сайт Angular SPA, категории не доступны через парсинг)
# Обновлять вручную при изменении структуры меню.
# Источник: div.mm-panels > div#mm-1 > ul.mm-listview > li > a[href]
# ════════════════════════════════════════════════════════════
TOP_CATEGORIES = [
    {"slug": "nedvizhimost",          "label": "Недвижимость",           "category_id": 1},
    {"slug": "transport-i-zapchasti", "label": "Транспорт и запчасти",   "category_id": 2},
    {"slug": "oborudovanie",          "label": "Оборудование",           "category_id": 3},
    {"slug": "komp-yutery",           "label": "Компьютеры",             "category_id": 4},
    {"slug": "telefony-i-svyaz",      "label": "Телефоны и связь",       "category_id": 5},
    {"slug": "mebel-i-inter-er",      "label": "Мебель и интерьер",      "category_id": 6},
    {"slug": "produkty-pitaniya",     "label": "Продукты питания",       "category_id": 7},
    {"slug": "tehnika-v-bytu",        "label": "Техника в быту",         "category_id": 8},
    {"slug": "odezhda-obuv-i-dr",     "label": "Одежда, обувь и др.",    "category_id": 9},
    {"slug": "stroitel-stvo",         "label": "Строительство",          "category_id": 10},
    {"slug": "nematerial-nye",        "label": "Нематериальные",         "category_id": 11},
    {"slug": "pravo-arendy-i-uslugi", "label": "Право аренды и услуги",  "category_id": 167},
    {"slug": "zhivotnye-i-rasteniya", "label": "Животные и растения",    "category_id": 164},
]

# Шаблон URL лота: /lot/{lot_id}/{auction_id}/
_LOT_URL_RE = re.compile(r"^/lot/(\d+)/(\d+)/$")

SESSION = requests.Session()
SESSION.headers.update(cfg.REQUEST_HEADERS)


# ════════════════════════════════════════════════════════════
# HTTP
# ════════════════════════════════════════════════════════════

def get_soup(url: str) -> BeautifulSoup | None:
    for attempt in range(1, cfg.REQUEST_RETRIES + 1):
        try:
            r = SESSION.get(url, timeout=cfg.REQUEST_TIMEOUT)
            r.raise_for_status()
            return BeautifulSoup(r.text, "html.parser")
        except requests.RequestException as e:
            wait = cfg.RETRY_BASE_DELAY * attempt
            print(f"  [!] Попытка {attempt}/{cfg.REQUEST_RETRIES}: {e}")
            if attempt < cfg.REQUEST_RETRIES:
                print(f"      Жду {wait:.0f}с…")
                time.sleep(wait)
    return None


def pause(base: float) -> None:
    jitter = random.uniform(-cfg.DELAY_JITTER, cfg.DELAY_JITTER)
    actual = max(base + jitter, cfg.DELAY_MINIMUM)
    time.sleep(actual)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


# ════════════════════════════════════════════════════════════
# КАТАЛОГ — СПИСОК ЛОТОВ
# ════════════════════════════════════════════════════════════

def extract_lot_urls(soup: BeautifulSoup) -> list[str]:
    """
    Извлекает stored-URL лотов со страницы каталога.
    Stored-формат: "torgi.gov.by/lot/{lot_id}/{auction_id}/"
    """
    urls, seen = [], set()
    for a in soup.find_all("a", href=True):
        href = unquote(a["href"])
        if href.startswith(BASE_URL):
            path = href[len(BASE_URL):]
        elif href.startswith("/"):
            path = href
        else:
            continue
        path = path.split("?")[0].split("#")[0]
        if not path.endswith("/"):
            path += "/"
        if not _LOT_URL_RE.fullmatch(path):
            continue
        stored = "torgi.gov.by" + path
        if stored not in seen:
            seen.add(stored)
            urls.append(stored)
    return urls


def build_catalog_url(slug: str, category_id: int, page: int = 1) -> str:
    return f"{BASE_URL}/catalog/{slug}/{page}/?category={category_id}"


def get_next_page_url(soup: BeautifulSoup, current_url: str) -> str | None:
    """Ищет ссылку на следующую страницу в пагинации."""
    m = re.search(r"/catalog/[^/]+/(\d+)/", current_url)
    cur = int(m.group(1)) if m else 1

    for a in soup.find_all("a", href=True):
        cls = " ".join(a.get("class", []))
        text = a.get_text(strip=True)
        href = unquote(a["href"])
        if any(x in cls for x in ["next", "forward"]) or text in (">", "»", "Следующая"):
            return urljoin(BASE_URL, href)

    slug_m = re.search(r"/catalog/([^/]+)/\d+/", current_url)
    if slug_m:
        slug = slug_m.group(1)
        next_pattern = f"/catalog/{slug}/{cur + 1}/"
        for a in soup.find_all("a", href=True):
            if next_pattern in unquote(a["href"]):
                return urljoin(BASE_URL, unquote(a["href"]))
    return None


# ════════════════════════════════════════════════════════════
# АЛГОРИТМ НОВЫХ ЛОТОВ (аналог lib.find_new_lots)
# ════════════════════════════════════════════════════════════

def find_new_lots(
    daily_paths: list[str],
    snapshot: dict[str, int],
    seq_window: int = None,
    seq_min_matches: int = None,
) -> list[str]:
    if seq_window is None:
        seq_window = cfg.SEQ_WINDOW
    if seq_min_matches is None:
        seq_min_matches = cfg.SEQ_MIN_MATCHES

    new_paths: list[str] = []
    i = 0
    n = len(daily_paths)

    while i < n:
        path = daily_paths[i]

        if path not in snapshot:
            new_paths.append(path)
            i += 1
            continue

        anchor_rank = snapshot[path]
        window = daily_paths[i + 1: i + 1 + seq_window]
        window_known = [(snapshot[w], w) for w in window if w in snapshot]

        matches = 0
        prev_rank = anchor_rank
        for rank, _ in window_known:
            if rank > prev_rank:
                matches += 1
                prev_rank = rank
                if matches >= seq_min_matches:
                    break

        effective_min = min(seq_min_matches, len(window_known))
        if effective_min > 0 and matches >= effective_min:
            print(f"  [⏹] Стоп: {matches} совпадений на «{path}»")
            break
        else:
            new_paths.append(path)
            i += 1

    return new_paths


# ════════════════════════════════════════════════════════════
# ДЕТАЛИ ЛОТА
# ════════════════════════════════════════════════════════════

def _lot_id_from_stored(stored: str) -> str:
    m = re.search(r"/lot/(\d+)/", stored)
    return m.group(1) if m else ""


def stored_to_url(stored: str) -> str:
    if stored.startswith("https://"):
        return stored
    return "https://" + stored


def _extract_table_part1(soup: BeautifulSoup) -> dict:
    """
    .detail_lot_part1 — Общие сведения о лоте.
    Поля: Наименование, Категория, Регион, Местонахождение имущества.
    """
    result = {"title": "", "category": "", "region": "", "location": ""}
    table = soup.find("table", class_="detail_lot_part1")
    if not table:
        return result
    for row in table.find_all("tr"):
        cells = row.find_all(["td", "th"])
        if len(cells) < 2:
            continue
        key = _clean(cells[0].get_text()).lower().rstrip(":")
        val = _clean(cells[1].get_text())
        if "наименование" in key:
            result["title"] = val
        elif "категория" in key:
            result["category"] = val
        elif key == "регион":
            result["region"] = val
        elif "местонахождение" in key or "местоположение" in key:
            result["location"] = val
    return result


def _extract_price(soup: BeautifulSoup) -> str:
    """
    .detail_lot_part2 — строка «Начальная цена единицы».
    "12 000.00 Руб(с НДС)" → "12 000.00 BYN"
    """
    table = soup.find("table", class_="detail_lot_part2")
    if not table:
        return ""
    for row in table.find_all("tr"):
        cells = row.find_all(["td", "th"])
        if len(cells) < 2:
            continue
        key = _clean(cells[0].get_text()).lower()
        if "начальная цена единицы" in key:
            raw = _clean(cells[1].get_text())
            m = re.search(r"([\d][\d\s]*[.,]\d{2})\s*Руб", raw, re.I)
            if m:
                num_str = m.group(1).replace(" ", "").replace(",", ".")
                try:
                    num = float(num_str)
                    formatted = f"{num:,.2f}".replace(",", " ")
                    return f"{formatted} BYN"
                except ValueError:
                    pass
            return raw
    return ""


def parse_lot_details(stored: str) -> dict:
    """
    Парсит страницу лота.
    Принимает stored-путь: "torgi.gov.by/lot/110430/33161/"
    Возвращает dict: url, lot_id, title, category, region, location, price.
    """
    url = stored_to_url(stored)
    empty = {
        "url":      url,
        "lot_id":   _lot_id_from_stored(stored),
        "title":    "",
        "category": "",
        "region":   "",
        "location": "",
        "price":    "",
    }
    soup = get_soup(url)
    if soup is None:
        empty["title"] = stored
        return empty

    d = dict(empty)
    part1 = _extract_table_part1(soup)
    d.update(part1)
    d["price"] = _extract_price(soup)
    return d
