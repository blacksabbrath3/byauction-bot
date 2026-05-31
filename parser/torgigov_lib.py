"""
torgigov_lib.py — функции парсера torgi.gov.by

Доступ к данным:
  api.torgi.gov.by/api заблокирован с GitHub Actions IP.
  Все API-запросы проксируются через Cloudflare Worker:

    GET  {WORKER}/api-lots?category=1&page=0&pagesize=50
         → Worker вызывает api.torgi.gov.by/api/lots → возвращает JSON
    POST {WORKER}/fetch-page {url: "https://torgi.gov.by/lot/..."}
         → Worker делает fetch() → возвращает {ok, status, html}

Список лотов: JSON API (не HTML-парсинг)
Данные лота:  JSON API (поля name, regionName, address, startPrice, ...)
Категории:    из меню главной страницы (SSR) + hardcoded fallback
"""

import re
import time
import random
import requests
from bs4 import BeautifulSoup
from urllib.parse import unquote

import config as cfg

BASE_URL    = "https://torgi.gov.by"
_SESSION    = requests.Session()
_SESSION.headers.update({"Content-Type": "application/json"})

# Шаблон URL лота: /lot/{lotId}/{auctionId}/
_LOT_URL_RE = re.compile(r"/lot/(\d+)/(\d+)/")


# ════════════════════════════════════════════════════════════
# HTTP К WORKER
# ════════════════════════════════════════════════════════════

def _worker_get(path: str, params: dict = None) -> dict | list | None:
    """GET {WORKER_URL}/{path}?params — возвращает parsed JSON или None."""
    url = f"{cfg.TORGIGOV_WORKER_URL}/{path.lstrip('/')}"
    for attempt in range(1, cfg.REQUEST_RETRIES + 1):
        try:
            r = _SESSION.get(
                url, params=params,
                headers={"X-API-Key": cfg.PARSER_SECRET},
                timeout=cfg.REQUEST_TIMEOUT,
            )
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            print(f"  [!] Worker GET {path} ({attempt}/{cfg.REQUEST_RETRIES}): {e}")
            if attempt < cfg.REQUEST_RETRIES:
                time.sleep(cfg.RETRY_BASE_DELAY * attempt)
    return None


def _worker_post(path: str, body: dict) -> dict | None:
    """POST {WORKER_URL}/{path} body — возвращает parsed JSON или None."""
    url = f"{cfg.TORGIGOV_WORKER_URL}/{path.lstrip('/')}"
    for attempt in range(1, cfg.REQUEST_RETRIES + 1):
        try:
            r = _SESSION.post(
                url, json=body,
                headers={"X-API-Key": cfg.PARSER_SECRET},
                timeout=cfg.REQUEST_TIMEOUT,
            )
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            print(f"  [!] Worker POST {path} ({attempt}/{cfg.REQUEST_RETRIES}): {e}")
            if attempt < cfg.REQUEST_RETRIES:
                time.sleep(cfg.RETRY_BASE_DELAY * attempt)
    return None


def get_soup(url: str) -> BeautifulSoup | None:
    """Получает HTML через Worker /fetch-page (для SSR-страниц)."""
    data = _worker_post("fetch-page", {"url": url})
    if not data:
        return None
    if not data.get("ok"):
        print(f"  [!] fetch-page error: {data.get('error')} (url={url})")
        return None
    status = data.get("status", 0)
    if status >= 400:
        print(f"  [!] fetch-page status={status} (url={url})")
        return None
    return BeautifulSoup(data["html"], "html.parser")


def pause(base: float) -> None:
    jitter = random.uniform(-cfg.DELAY_JITTER, cfg.DELAY_JITTER)
    time.sleep(max(base + jitter, cfg.DELAY_MINIMUM))


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


# ════════════════════════════════════════════════════════════
# КАТЕГОРИИ
# ════════════════════════════════════════════════════════════

_FALLBACK_CATEGORIES = [
    {"slug": "nedvizhimost",          "label": "Недвижимость",          "category_id": 1},
    {"slug": "transport-i-zapchasti", "label": "Транспорт и запчасти",  "category_id": 2},
    {"slug": "oborudovanie",          "label": "Оборудование",          "category_id": 3},
    {"slug": "komp-yutery",           "label": "Компьютеры",            "category_id": 4},
    {"slug": "telefony-i-svyaz",      "label": "Телефоны и связь",      "category_id": 5},
    {"slug": "mebel-i-inter-er",      "label": "Мебель и интерьер",     "category_id": 6},
    {"slug": "produkty-pitaniya",     "label": "Продукты питания",      "category_id": 7},
    {"slug": "tehnika-v-bytu",        "label": "Техника в быту",        "category_id": 8},
    {"slug": "odezhda-obuv-i-dr",     "label": "Одежда, обувь и др.",   "category_id": 9},
    {"slug": "stroitel-stvo",         "label": "Строительство",         "category_id": 10},
    {"slug": "nematerial-nye",        "label": "Нематериальные",        "category_id": 11},
    {"slug": "pravo-arendy-i-uslugi", "label": "Право аренды и услуги", "category_id": 167},
    {"slug": "zhivotnye-i-rasteniya", "label": "Животные и растения",   "category_id": 164},
]

_TOP_IDS = set(range(1, 14)) | {164, 167}
_CAT_PAT = re.compile(r"/catalog/([a-z0-9-]+)/1/%3Fcategory%3D(\d+)")


def parse_top_categories() -> list[dict]:
    """
    Парсит категории с главной страницы (SSR nav-меню через Worker).
    Ищет ссылки вида /catalog/{slug}/1/%3Fcategory%3D{id} — именно
    в таком URL-encoded виде они присутствуют в HTML.
    При неудаче возвращает _FALLBACK_CATEGORIES.
    """
    print("[→] Парсю категории torgi.gov.by…")
    soup = get_soup(BASE_URL + "/")
    if soup is None:
        print("[!] Главная недоступна — использую резервные категории")
        return list(_FALLBACK_CATEGORIES)

    seen: set[tuple] = set()
    categories: list[dict] = []

    def add(slug: str, cat_id: int, label: str) -> None:
        label = re.sub(r"\s*\d+\s*$", "", label).strip()
        if not label or len(label) > 120:
            return
        key = (slug, cat_id)
        if key not in seen:
            seen.add(key)
            categories.append({"slug": slug, "label": label, "category_id": cat_id})

    # Стратегия 1: ищем ссылки с %3F (encoded ?) в href — именно так они в HTML
    for a in soup.find_all("a", href=True):
        href = a["href"]  # НЕ unquote — ссылки хранятся в encoded виде
        m = _CAT_PAT.search(href)
        if not m:
            continue
        cat_id = int(m.group(2))
        if cat_id not in _TOP_IDS:
            continue
        # Пропускаем подкатегории
        if a.find_parent("li", class_="main_category_mnu_sub_item"):
            continue
        if a.find_parent("ul", class_="main_category_mnu_sub"):
            continue
        add(m.group(1), cat_id, _clean(a.get_text()))

    print(f"  [i] Стратегия 1 (%3F encoded): {len(categories)} категорий")

    # Стратегия 2: unquote + обычный ?category= (на случай если сервер вернёт иначе)
    if not categories:
        pat2 = re.compile(r"/catalog/([a-z0-9-]+)/1/\?category=(\d+)")
        for a in soup.find_all("a", href=True):
            href = unquote(a["href"])
            m = pat2.search(href)
            if not m:
                continue
            cat_id = int(m.group(2))
            if cat_id not in _TOP_IDS:
                continue
            if a.find_parent("li", class_="main_category_mnu_sub_item"):
                continue
            add(m.group(1), cat_id, _clean(a.get_text()))
        print(f"  [i] Стратегия 2 (unquoted): {len(categories)} категорий")

    if not categories:
        print("[!] Категории не найдены в HTML — использую резервные")
        return list(_FALLBACK_CATEGORIES)

    print(f"[✓] Категорий top-level: {len(categories)}")
    for c in categories:
        print(f"    {c['label']:50s} → {c['slug']} (id={c['category_id']})")
    return categories


# ════════════════════════════════════════════════════════════
# API: ПОЛУЧЕНИЕ ЛОТОВ
# ════════════════════════════════════════════════════════════

def _lot_id(raw: dict) -> str:
    """Извлекает ID лота из JSON-объекта API."""
    return str(raw.get("id") or raw.get("lotId") or raw.get("lot_id") or "")


def _make_lot_url(raw: dict) -> str:
    lot_id     = raw.get("id")     or raw.get("lotId")     or ""
    auction_id = raw.get("auctionId") or raw.get("auction_id") or raw.get("saleId") or ""
    url_slug   = raw.get("urlName") or raw.get("slug") or raw.get("nameUrl") or ""
    if url_slug:
        return f"{BASE_URL}/lot/{lot_id}/{auction_id}/{url_slug}"
    return f"{BASE_URL}/lot/{lot_id}/{auction_id}/"


def _format_price(val) -> str:
    if val is None or val == "":
        return ""
    try:
        num = float(str(val).replace(" ", "").replace(",", "."))
        # Форматируем с пробелами-разделителями тысяч
        int_part, dec_part = f"{num:.2f}".split(".")
        int_fmt = ""
        for i, ch in enumerate(reversed(int_part)):
            if i and i % 3 == 0:
                int_fmt = " " + int_fmt
            int_fmt = ch + int_fmt
        return f"{int_fmt}.{dec_part} BYN"
    except (ValueError, TypeError):
        return str(val)


def normalize_lot(raw: dict, slug: str) -> dict:
    """Нормализует объект лота из API в единый формат."""
    return {
        "lot_id":   _lot_id(raw),
        "url":      _make_lot_url(raw),
        "slug":     slug,
        "title":    str(raw.get("name")         or raw.get("title")       or raw.get("lotName")   or ""),
        "category": str(raw.get("categoryName") or raw.get("category")    or raw.get("categoryTitle") or ""),
        "region":   str(raw.get("regionName")   or raw.get("region")      or raw.get("regionTitle")   or ""),
        "location": str(raw.get("address")      or raw.get("location")    or raw.get("lotAddress")    or ""),
        "price":    _format_price(raw.get("startPrice") or raw.get("price") or raw.get("startCost") or ""),
    }


def fetch_lots_page(category_id: int, slug: str, page: int = 0, pagesize: int = 50) -> tuple[list[dict], int]:
    """
    Запрашивает одну страницу лотов через Worker /api-lots.
    Worker возвращает: {"lots": [...], "count": N, "totalPages": N}
    """
    url    = f"{cfg.TORGIGOV_WORKER_URL}/api-lots"
    params = {"category": category_id, "page": page, "pagesize": pagesize}

    for attempt in range(1, cfg.REQUEST_RETRIES + 1):
        try:
            r = _SESSION.get(
                url, params=params,
                headers={"X-API-Key": cfg.PARSER_SECRET},
                timeout=cfg.REQUEST_TIMEOUT,
            )
            r.raise_for_status()
            data = r.json()
            break
        except requests.exceptions.JSONDecodeError as e:
            print(f"  [!] JSON decode error: {e}, body={r.text[:200]}")
            return [], 0
        except requests.RequestException as e:
            print(f"  [!] api-lots attempt {attempt}/{cfg.REQUEST_RETRIES}: {e}")
            if attempt < cfg.REQUEST_RETRIES:
                time.sleep(cfg.RETRY_BASE_DELAY * attempt)
            else:
                return [], 0
    else:
        return [], 0

    if not isinstance(data, dict):
        print(f"  [!] Неожиданный тип ответа: {type(data)}")
        return [], 0

    if "error" in data and not data.get("ok", True):
        print(f"  [!] Worker error: {data.get('error', data)}")
        return [], 0

    raw_lots    = data.get("lots", [])
    total_pages = int(data.get("totalPages", 1) or 1)

    if not isinstance(raw_lots, list):
        print(f"  [!] lots не список: {type(raw_lots)}")
        return [], 0

    lots = [normalize_lot(r, slug) for r in raw_lots if _lot_id(r)]
    return lots, total_pages


# ════════════════════════════════════════════════════════════
# АЛГОРИТМ НОВЫХ ЛОТОВ
# ID лотов монотонно возрастают — сравниваем множествами.
# ════════════════════════════════════════════════════════════

def find_new_lots_by_id(
    fetched_lots: list[dict],
    known_ids: set[str],
) -> list[dict]:
    """
    Возвращает лоты чьи lot_id отсутствуют в known_ids.
    Лоты уже отсортированы по убыванию новизны (sort1=approvetime).
    Останавливаемся при первом известном ID — это признак что
    все последующие тоже известны.
    """
    new_lots = []
    for lot in fetched_lots:
        lid = lot["lot_id"]
        if not lid:
            continue
        if lid in known_ids:
            # Встретили известный — дальше только старые
            break
        new_lots.append(lot)
    return new_lots


# ════════════════════════════════════════════════════════════
# ДАННЫЕ ЛОТА (страница лота — SSR)
# Используется только если API не вернул достаточно полей.
# ════════════════════════════════════════════════════════════

def _extract_lot_from_page(soup: BeautifulSoup, stored_url: str) -> dict:
    """Парсит поля лота из SSR-страницы (fallback)."""
    m = _LOT_URL_RE.search(stored_url)
    lot_id = m.group(1) if m else ""

    result = {
        "lot_id": lot_id, "url": stored_url,
        "title": "", "category": "", "region": "", "location": "", "price": "",
    }

    table1 = soup.find("table", class_="detail_lot_part1")
    if table1:
        for row in table1.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            key = _clean(cells[0].get_text()).lower().rstrip(":")
            val = _clean(cells[1].get_text())
            if "наименование" in key:   result["title"]    = val
            elif "категория" in key:    result["category"] = val
            elif key == "регион":       result["region"]   = val
            elif "местонахожден" in key: result["location"] = val

    table2 = soup.find("table", class_="detail_lot_part2")
    if table2:
        for row in table2.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            if "начальная цена единицы" in _clean(cells[0].get_text()).lower():
                raw = _clean(cells[1].get_text())
                m2  = re.search(r"([\d][\d\s]*[.,]\d{2})\s*Руб", raw, re.I)
                if m2:
                    result["price"] = _format_price(
                        m2.group(1).replace(" ", "").replace(",", ".")
                    )
                else:
                    result["price"] = raw
    return result
