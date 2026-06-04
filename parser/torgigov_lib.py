"""
torgigov_lib.py — функции парсера torgi.gov.by

Доступ к данным через Cloudflare Worker (api.torgi.gov.by заблокирован с GitHub IP):
  GET  {WORKER}/api-lots?category=1&page=0&pagesize=50
       → Worker → api.torgi.gov.by/api/lots → {"lots":[...],"count":N,"totalPages":N}
  POST {WORKER}/fetch-page {url}
       → Worker → torgi.gov.by SSR-страница → {ok, status, html}

Структура ответа API:
  {"status":200,"result":{"lots":[{id,name,location,numAuction,initialPrice,region,...}],
                          "totCnt":N,"summary":...}}
  Worker разворачивает в: {"lots":[...],"count":N,"totalPages":N}
"""

import re
import time
import random
import requests
from bs4 import BeautifulSoup
from urllib.parse import unquote

import config as cfg

BASE_URL = "https://torgi.gov.by"
_LOT_URL_RE = re.compile(r"/lot/(\d+)/(\d+)/")

_SESSION = requests.Session()


# ════════════════════════════════════════════════════════════
# HTTP К WORKER
# ════════════════════════════════════════════════════════════

def _worker_post(path: str, body: dict) -> dict | None:
    url = f"{cfg.TORGIGOV_WORKER_URL}/{path.lstrip('/')}"
    for attempt in range(1, cfg.REQUEST_RETRIES + 1):
        try:
            r = _SESSION.post(
                url, json=body,
                headers={"X-API-Key": cfg.PARSER_SECRET,
                         "Content-Type": "application/json"},
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
# Ссылки в HTML хранятся в URL-encoded виде: /catalog/{slug}/1/%3Fcategory%3D{id}
_CAT_PAT_ENCODED = re.compile(r"/catalog/([a-z0-9-]+)/1/%3Fcategory%3D(\d+)")
_CAT_PAT_PLAIN   = re.compile(r"/catalog/([a-z0-9-]+)/1/\?category=(\d+)")


def parse_top_categories() -> list[dict]:
    """
    Возвращает список top-level категорий.
    Главная страница torgi.gov.by — Angular SPA, меню в SSR не рендерится.
    Категории стабильны (IDs 1-11, 167, 164 не меняются), поэтому
    используем hardcoded список. Раз в месяц snapshot сохраняет его в KV.
    """
    print("[→] Использую список категорий torgi.gov.by…")
    categories = list(_FALLBACK_CATEGORIES)
    print(f"[✓] Категорий: {len(categories)}")
    return categories


# ════════════════════════════════════════════════════════════
# API: ПОЛУЧЕНИЕ ЛОТОВ
# ════════════════════════════════════════════════════════════

def _lot_id(raw: dict) -> str:
    return str(raw.get("id") or "")


def _format_price(val) -> str:
    if val is None or val == "" or val == 0:
        return ""
    try:
        num = int(float(str(val).replace(" ", "").replace(",", ".")))
        if num == 0:
            return ""
        return f"{num:,}".replace(",", " ") + " BYN"
    except (ValueError, TypeError):
        return str(val)


def normalize_lot(raw: dict, slug: str) -> dict:
    """
    Нормализует объект лота из API.
    Поля из реального ответа: id, name, location, numAuction,
    initialPrice, region (int ID), category (int ID).
    """
    lot_id     = str(raw.get("id") or "")
    auction_id = str(raw.get("numAuction") or "")
    url        = f"{BASE_URL}/lot/{lot_id}/{auction_id}/" if lot_id and auction_id else ""

    return {
        "lot_id":   lot_id,
        "url":      url,
        "slug":     slug,
        "title":    str(raw.get("name") or ""),
        "category": str(raw.get("category") or ""),   # числовой ID
        "region":   str(raw.get("region") or ""),     # числовой ID
        "location": str(raw.get("location") or ""),
        "price":    _format_price(raw.get("initialPrice") or raw.get("currentInitialPrice")),
        "state":    str(raw.get("state") or ""),
    }


def fetch_lots_page(
    category_id: int, slug: str,
    page: int = 0, pagesize: int = 50,
) -> tuple[list[dict], int]:
    """
    Запрашивает страницу лотов через Worker /api-lots.
    Возвращает (лоты, totalPages).
    """
    worker_url = (f"{cfg.TORGIGOV_WORKER_URL}/api-lots"
                  .replace("//api-lots", "/api-lots"))
    params     = {"category": category_id, "page": page, "pagesize": pagesize}

    for attempt in range(1, cfg.REQUEST_RETRIES + 1):
        try:
            r = requests.get(
                worker_url, params=params,
                headers={"X-API-Key": cfg.PARSER_SECRET},
                timeout=cfg.REQUEST_TIMEOUT,
            )
            if r.status_code >= 400:
                print(f"  [!] /api-lots HTTP {r.status_code}: {r.text[:200]}")
                if attempt < cfg.REQUEST_RETRIES:
                    time.sleep(cfg.RETRY_BASE_DELAY * attempt)
                    continue
                return [], 0
            data = r.json()
            break
        except requests.exceptions.JSONDecodeError as e:
            print(f"  [!] JSON error: {e}, body={r.text[:100]}")
            return [], 0
        except requests.RequestException as e:
            print(f"  [!] /api-lots attempt {attempt}/{cfg.REQUEST_RETRIES}: {e}")
            if attempt < cfg.REQUEST_RETRIES:
                time.sleep(cfg.RETRY_BASE_DELAY * attempt)
            else:
                return [], 0
    else:
        return [], 0

    if not isinstance(data, dict):
        return [], 0
    if "error" in data and not data.get("ok", True):
        print(f"  [!] Worker error: {data.get('error')}")
        return [], 0

    raw_lots    = data.get("lots", [])
    total_pages = int(data.get("totalPages", 1) or 1)

    if not isinstance(raw_lots, list):
        return [], 0

    lots = [normalize_lot(r, slug) for r in raw_lots if _lot_id(r)]
    return lots, total_pages


# ════════════════════════════════════════════════════════════
# АЛГОРИТМ НОВЫХ ЛОТОВ
# ════════════════════════════════════════════════════════════

def find_new_lots_by_id(
    fetched_lots: list[dict],
    known_ids: set[str],
) -> list[dict]:
    """
    Возвращает лоты с неизвестными ID.
    Останавливается при первом известном — API сортирует по убыванию новизны.
    """
    new_lots = []
    for lot in fetched_lots:
        lid = lot["lot_id"]
        if not lid:
            continue
        if lid in known_ids:
            break
        new_lots.append(lot)
    return new_lots


# ════════════════════════════════════════════════════════════
# СТРАНИЦА ЛОТА (SSR fallback — если нужны доп. поля)
# ════════════════════════════════════════════════════════════

def _extract_lot_from_page(soup: BeautifulSoup, url: str) -> dict:
    m = _LOT_URL_RE.search(url)
    lot_id = m.group(1) if m else ""
    result = {"lot_id": lot_id, "url": url,
               "title": "", "category": "", "region": "", "location": "", "price": ""}
    table1 = soup.find("table", class_="detail_lot_part1")
    if table1:
        for row in table1.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            key = _clean(cells[0].get_text()).lower().rstrip(":")
            val = _clean(cells[1].get_text())
            if "наименование" in key:    result["title"]    = val
            elif "категория" in key:     result["category"] = val
            elif key == "регион":        result["region"]   = val
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
                        m2.group(1).replace(" ", "").replace(",", "."))
                else:
                    result["price"] = raw
    return result
  
