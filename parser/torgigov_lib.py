"""
torgigov_lib.py — функции парсера torgi.gov.by

Доступ к данным через Cloudflare Worker (api.torgi.gov.by заблокирован с GitHub IP):
  GET  {WORKER}/api-lots?category=N&page=0&pagesize=50
       → Worker → api.torgi.gov.by/api/lots → {"lots":[...],"count":N,"totalPages":N}
  POST {WORKER}/fetch-page {url}
       → Worker → torgi.gov.by SSR-страница → {ok, status, html}

ВАЖНО: API torgi.gov.by требует параметр category как обязательный —
запрос без category возвращает HTTP 200, но с телом {"status":400,...}.
Поэтому общий список ("Недавно добавленные" с главной страницы) через API
недоступен напрямую — приходится идти по списку всех категорий.

Список категорий (CATEGORIES) восстановлен из реального HTML-меню сайта
(не из устаревшего захардкоженного списка) — 133 категории с точными
числовыми ID, включая и пустые на момент снятия (могут наполниться позже).

Структура ответа API:
  {"status":200,"result":{"lots":[{id,name,location,numAuction,initialPrice,region,...}],
                          "totCnt":N,"summary":...}}
  Worker разворачивает в: {"lots":[...],"count":N,"totalPages":N}
"""

import re
import time
import requests
from bs4 import BeautifulSoup

import config as cfg

BASE_URL = "https://torgi.gov.by"
_LOT_URL_RE = re.compile(r"/lot/(\d+)/(\d+)/")

_SESSION = requests.Session()


# ════════════════════════════════════════════════════════════
# КАТЕГОРИИ — полный список с реальными ID (см. докстринг выше)
# ════════════════════════════════════════════════════════════

CATEGORIES = [
    {"slug": "zdaniya-proizvodstvennogo-naznacheniya", "label": "Здания производственного назначения", "category_id": 13},
    {"slug": "zdaniya-ofisnogo-naznacheniya", "label": "Здания офисного назначения", "category_id": 14},
    {"slug": "doma-kottedzhi", "label": "Дома, коттеджи", "category_id": 15},
    {"slug": "pavil-ony-nestacionarnye-konstrukcii", "label": "Павильоны, нестационарные конструкции", "category_id": 16},
    {"slug": "kvartiry", "label": "Квартиры", "category_id": 17},
    {"slug": "zemel-nye-uchastki", "label": "Земельные участки", "category_id": 18},
    {"slug": "garazhi-parkovki-mashinomesto", "label": "Гаражи, парковки, машиноместо", "category_id": 19},
    {"slug": "gruzovoj-transport", "label": "Грузовой транспорт", "category_id": 20},
    {"slug": "legkovye-mashiny", "label": "Легковые машины", "category_id": 22},
    {"slug": "pricepy", "label": "Прицепы", "category_id": 23},
    {"slug": "motocikly", "label": "Мотоциклы", "category_id": 24},
    {"slug": "inoj-legkovoj-transport", "label": "Иной легковой транспорт", "category_id": 26},
    {"slug": "zapchasti-k-gruzovomu-transportu", "label": "Запчасти к грузовому транспорту", "category_id": 27},
    {"slug": "zapchasti-k-legkovomu-transportu", "label": "Запчасти к легковому транспорту", "category_id": 28},
    {"slug": "shiny-kolesa-diski", "label": "Шины, колеса, диски", "category_id": 29},
    {"slug": "avtoinstrument", "label": "Автоинструмент", "category_id": 30},
    {"slug": "avtoelektronika", "label": "Автоэлектроника", "category_id": 31},
    {"slug": "oborudovanie-dlya-remonta", "label": "Оборудование для ремонта", "category_id": 32},
    {"slug": "ofisnoe-oborudovanie", "label": "Офисное оборудование", "category_id": 33},
    {"slug": "proizvodstvennoe-oborudovanie", "label": "Производственное оборудование", "category_id": 34},
    {"slug": "torgovoe-oborudovanie", "label": "Торговое оборудование", "category_id": 35},
    {"slug": "bytovoe-naznachenie", "label": "Бытовое назначение", "category_id": 36},
    {"slug": "mashiny-i-mehanizmy", "label": "Машины и механизмы", "category_id": 37},
    {"slug": "otoplenie-vodosnabzhenie", "label": "Отопление водоснабжение", "category_id": 38},
    {"slug": "zabory-ograzhdeniya", "label": "Заборы, ограждения", "category_id": 39},
    {"slug": "komp-yutery-domashnie", "label": "Компьютеры Домашние", "category_id": 40},
    {"slug": "programmnoe-obespechenie", "label": "Программное обеспечение", "category_id": 44},
    {"slug": "setevoe-oborudovanie", "label": "Сетевое оборудование", "category_id": 45},
    {"slug": "mobil-nye-telefony", "label": "Мобильные телефоны", "category_id": 46},
    {"slug": "stacionarnye-telefony", "label": "Стационарные телефоны", "category_id": 47},
    {"slug": "faksy", "label": "Факсы", "category_id": 49},
    {"slug": "radiostancii", "label": "Радиостанции", "category_id": 50},
    {"slug": "mebel-v-obshie-pomesheniya", "label": "Мебель в общие помещения", "category_id": 51},
    {"slug": "mebel-v-vannuyu-komnatu", "label": "Мебель в ванную комнату", "category_id": 52},
    {"slug": "lyustry-i-svetil-niki", "label": "Люстры и светильники", "category_id": 53},
    {"slug": "posuda", "label": "Посуда", "category_id": 54},
    {"slug": "tovary-hozyajstvennogo-naznacheniya", "label": "Товары хозяйственного назначения", "category_id": 55},
    {"slug": "zootovary", "label": "Зоотовары", "category_id": 56},
    {"slug": "krupy-muka", "label": "Крупы, мука", "category_id": 57},
    {"slug": "kofe-chaj", "label": "Кофе, чай", "category_id": 58},
    {"slug": "tabachnye-izdeliya", "label": "Табачные изделия", "category_id": 59},
    {"slug": "televizory", "label": "Телевизоры", "category_id": 60},
    {"slug": "holodil-niki", "label": "Холодильники", "category_id": 61},
    {"slug": "stiral-nye-mashiny", "label": "Стиральные машины", "category_id": 62},
    {"slug": "posudomoechnye-mashiny", "label": "Посудомоечные машины", "category_id": 63},
    {"slug": "mikrovolnovye-pechi", "label": "Микроволновые печи", "category_id": 64},
    {"slug": "inaya-tehnika", "label": "Иная техника", "category_id": 65},
    {"slug": "domashnij-tekstil", "label": "Домашний текстиль", "category_id": 66},
    {"slug": "zhenskaya-odezhda", "label": "Женская одежда", "category_id": 67},
    {"slug": "zhenskaya-obuv", "label": "Женская обувь", "category_id": 68},
    {"slug": "muzhskaya-odezhda", "label": "Мужская одежда", "category_id": 69},
    {"slug": "muzhskaya-obuv", "label": "Мужская обувь", "category_id": 70},
    {"slug": "detskaya-odezhda", "label": "Детская одежда", "category_id": 71},
    {"slug": "detskaya-obuv", "label": "Детская обувь", "category_id": 72},
    {"slug": "detskie-tovary-igrushki", "label": "Детские товары, игрушки", "category_id": 73},
    {"slug": "ukrasheniya", "label": "Украшения", "category_id": 74},
    {"slug": "chasy", "label": "Часы", "category_id": 75},
    {"slug": "aksessuary", "label": "Аксессуары", "category_id": 76},
    {"slug": "golovnye-ubory", "label": "Головные уборы", "category_id": 77},
    {"slug": "sporttovary", "label": "Спорттовары", "category_id": 78},
    {"slug": "instrument", "label": "Инструмент", "category_id": 79},
    {"slug": "stroitel-nye-i-otdelochnye-materialy", "label": "Строительные и отделочные материалы", "category_id": 80},
    {"slug": "stroitel-noe-oborudovanie", "label": "Строительное оборудование", "category_id": 81},
    {"slug": "santehnika", "label": "Сантехника", "category_id": 82},
    {"slug": "sadovaya-tehnika-i-instrumenty", "label": "Садовая техника и инструменты", "category_id": 83},
    {"slug": "rasteniya", "label": "Растения", "category_id": 84},
    {"slug": "prava-na-intellektual-nuyu-sobstvennost", "label": "Права на интеллектуальную собственность", "category_id": 86},
    {"slug": "debitorskaya-zadolzhennost", "label": "Дебиторская задолженность", "category_id": 87},
    {"slug": "igrovye", "label": "Игровые", "category_id": 96},
    {"slug": "igrovye-pristavki", "label": "Игровые приставки", "category_id": 102},
    {"slug": "ovoshi-i-frukty", "label": "Овощи и фрукты", "category_id": 103},
    {"slug": "zamorozhennye-produkty", "label": "Замороженные продукты", "category_id": 105},
    {"slug": "hlebobulochnye-izdeliya", "label": "Хлебобулочные изделия", "category_id": 106},
    {"slug": "bezalkogol-nye-napitki", "label": "Безалкогольные напитки", "category_id": 107},
    {"slug": "produkty-zhivotnogo-proishozhdeniya", "label": "Продукты животного происхождения", "category_id": 108},
    {"slug": "produkty-rastitel-nogo-proishozhdeniya", "label": "Продукты растительного происхождения", "category_id": 109},
    {"slug": "ovoshi", "label": "Овощи", "category_id": 110},
    {"slug": "frukty", "label": "Фрукты", "category_id": 111},
    {"slug": "svinina", "label": "Свинина", "category_id": 112},
    {"slug": "govyadina", "label": "Говядина", "category_id": 113},
    {"slug": "kurica", "label": "Курица", "category_id": 114},
    {"slug": "inoe-myaso", "label": "Иное мясо", "category_id": 115},
    {"slug": "inye-produkty", "label": "Иные продукты", "category_id": 116},
    {"slug": "ohlazhdennye-produkty", "label": "Охлажденные продукты", "category_id": 117},
    {"slug": "produkty-glubokoj-zamorozki", "label": "Продукты глубокой заморозки", "category_id": 118},
    {"slug": "kuhonnye-plity", "label": "Кухонные плиты", "category_id": 119},
    {"slug": "pylesosy", "label": "Пылесосы", "category_id": 120},
    {"slug": "kofe", "label": "Кофе", "category_id": 121},
    {"slug": "chaj", "label": "Чай", "category_id": 122},
    {"slug": "elektrika", "label": "Электрика", "category_id": 123},
    {"slug": "dveri-okna", "label": "Двери, окна", "category_id": 124},
    {"slug": "mobil-nye-telefony-2", "label": "Мобильные телефоны (аксессуары)", "category_id": 128},
    {"slug": "akkumulyatory", "label": "Аккумуляторы", "category_id": 129},
    {"slug": "chehly", "label": "Чехлы", "category_id": 130},
    {"slug": "zaryadnye-ustrojstva", "label": "Зарядные устройства", "category_id": 131},
    {"slug": "karty-pamyati", "label": "Карты памяти", "category_id": 132},
    {"slug": "prochie-aksessuary", "label": "Прочие аксессуары", "category_id": 133},
    {"slug": "telefony-dect", "label": "Телефоны DECT", "category_id": 134},
    {"slug": "provodnye-telefony", "label": "Проводные телефоны", "category_id": 135},
    {"slug": "tovarnye-znaki", "label": "Товарные знаки", "category_id": 136},
    {"slug": "doli-v-ustavnom-fonde", "label": "Доли в уставном фонде", "category_id": 137},
    {"slug": "vodnyj-transport", "label": "Водный транспорт", "category_id": 139},
    {"slug": "vozdushnyj-transport", "label": "Воздушный транспорт", "category_id": 140},
    {"slug": "sel-skohozyajstvennaya-tehnika", "label": "Сельскохозяйственная техника", "category_id": 141},
    {"slug": "traktory", "label": "Тракторы", "category_id": 142},
    {"slug": "obrabotka-i-podgotovka-pochvy", "label": "Обработка и подготовка почвы", "category_id": 143},
    {"slug": "posev-i-posadka", "label": "Посев и посадка", "category_id": 144},
    {"slug": "uhod-za-kul-turami", "label": "Уход за культурами", "category_id": 145},
    {"slug": "sbor-zernovyh-kul-tur", "label": "Сбор зерновых культур", "category_id": 146},
    {"slug": "sbor-kormov", "label": "Сбор кормов", "category_id": 147},
    {"slug": "sbor-ovoshej", "label": "Сбор овощей", "category_id": 148},
    {"slug": "sbor-drugih-kul-tur", "label": "Сбор других культур", "category_id": 149},
    {"slug": "posleuborochnaya-obrabotka", "label": "Послеуборочная обработка", "category_id": 150},
    {"slug": "zhivotnovodstvo", "label": "Животноводство", "category_id": 151},
    {"slug": "minitehnika", "label": "Минитехника", "category_id": 152},
    {"slug": "zapchasti-k-sel-skohozyajstvennoj-tehnike", "label": "Запчасти к сельскохозяйственной технике", "category_id": 153},
    {"slug": "special-naya-tehnika", "label": "Специальная техника", "category_id": 154},
    {"slug": "mini-ats", "label": "Мини АТС", "category_id": 155},
    {"slug": "prochee", "label": "Прочее", "category_id": 156},
    {"slug": "special-nye-programmy", "label": "Специальные программы", "category_id": 158},
    {"slug": "internet-sajty", "label": "Интернет-сайты", "category_id": 159},
    {"slug": "operacionnye-sistemy", "label": "Операционные системы", "category_id": 160},
    {"slug": "video-fotomaterialy", "label": "Видео-фотоматериалы", "category_id": 161},
    {"slug": "imushestvennyj-kompleks", "label": "Имущественный комплекс", "category_id": 162},
    {"slug": "pravo-arendy", "label": "Право аренды", "category_id": 163},
    {"slug": "upakovochnye-materialy-i-tara", "label": "Упаковочные материалы и тара", "category_id": 165},
    {"slug": "syr-e-i-materialy", "label": "Сырье и Материалы", "category_id": 166},
    {"slug": "nedvizhimost", "label": "Недвижимость", "category_id": 168},
    {"slug": "transport", "label": "Транспорт", "category_id": 170},
    {"slug": "oborudovanie", "label": "Оборудование", "category_id": 171},
    {"slug": "special-naya-tehnika-2", "label": "Специальная техника (доп.)", "category_id": 172},
    {"slug": "uslugi", "label": "Услуги", "category_id": 174},
    {"slug": "medicinskogo-i-veterinarnogo-naznacheniya", "label": "Медицинского и ветеринарного назначения", "category_id": 175},
]


def parse_top_categories() -> list[dict]:
    """Возвращает полный список категорий (см. CATEGORIES выше)."""
    return list(CATEGORIES)


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
    """Получает HTML через Worker /fetch-page (для SSR-страниц лотов)."""
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
    import random
    jitter = random.uniform(-cfg.DELAY_JITTER, cfg.DELAY_JITTER)
    time.sleep(max(base + jitter, cfg.DELAY_MINIMUM))


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


# ════════════════════════════════════════════════════════════
# API: ПОЛУЧЕНИЕ ЛОТОВ (без категорий — общий список)
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


def normalize_lot(raw: dict, slug: str = "") -> dict:
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
    category_id: int, slug: str = "",
    page: int = 0, pagesize: int = 50,
) -> tuple[list[dict], int]:
    """
    Запрашивает страницу лотов конкретной категории через Worker /api-lots.
    API torgi.gov.by требует category как обязательный параметр.
    Возвращает (лоты, totalPages).
    """
    worker_url = f"{cfg.TORGIGOV_WORKER_URL}/api-lots"
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

    if not raw_lots and data.get("_debug_apiUrl"):
        print(f"  [debug] apiUrl={data.get('_debug_apiUrl')}")
        print(f"  [debug] apiStatus={data.get('_debug_apiStatus')}")
        print(f"  [debug] rawBody={data.get('_debug_rawBody', '')[:300]}")

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
