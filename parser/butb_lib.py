"""
butb_lib.py — функции парсера et.butb.by (БУТБ — Имущество)

Сайт построен на JSF/ICEFaces (Java Server Faces).
Прямой доступ с GitHub IP заблокирован (403), поэтому
все запросы идут через Cloudflare Worker:

  POST {WORKER}/fetch-page  {url}              → {ok, status, html}
      Простой GET-запрос к et.butb.by — для первой страницы.

  POST {WORKER}/fetch-form  {url, form_data}   → {ok, status, html}
      POST-запрос с данными формы — для пагинации (ICEFaces submit).

Структура страницы листинга (et.butb.by/et/auctions.xhtml):
  - Таблица лотов: #f_lots:tableLot  (class="ui-datatable datatable-reestr")
  - Строки: tr.ui-datatable-even / tr.ui-datatable-odd
  - Пагинатор: .ui-paginator  с <a page="N"> ссылками
  - Форма: #f_lots   action="/et/auctions.xhtml"
  - Рубрикатор: .a-rubricator с <a id="f_lots:j_idt179:N:_t183">

Поля лота в строке таблицы:
  - lot_id:      из href="...lotid=27460..."
  - url:         https://et.butb.by/et/lotcard.xhtml?lotid=27460&prevPage=auctions
  - title:       .lot-name
  - status:      .lot-status2
  - lot_num:     первый .lot-item-title  (Лот № N)
  - trade_num:   второй .lot-item-title  (Торги № AXXXXX)
  - organizer:   .lot-item-descript-org-name-descript
  - location:    .lot-item-descript-org-place > p
  - price:       первый .info-block-value span (начальная цена)
  - currency:    второй span в .info-block-value
  - deposit:     .info-block-value2 первый (задаток)
  - deadline:    .info-block-value2 второй (окончание приёма заявлений)
  - trade_date:  .info-block-value2 третий (дата и время торгов)
"""

import re
import time
import random
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlencode, parse_qs

import config as cfg

BASE_URL    = "https://et.butb.by"
AUCTIONS_URL = f"{BASE_URL}/et/auctions.xhtml"

_SESSION = requests.Session()

# Рубрики: slug → индекс в рубрикаторе (j_idt179:N)
# Индексы взяты из сохранённой страницы, порядок стабилен
RUBRICS = {
    "all":          0,   # Все лоты
    "realestate":   1,   # Недвижимость
    "land":         2,   # Земельные участки
    "transport":    3,   # Транспорт и спецтехника
    "equipment":    4,   # Станки и оборудование
    "inventory":    5,   # Инвентарь и хоз. принадлежности
    "other":        6,   # Другое имущество
    "rent":         7,   # Аренда
    "construction": 8,   # Проектирование и строительство капстроений
    "share":        9,   # Доля в собственности
}

RUBRIC_LABELS = {
    "all":          "🏛️ Все лоты БУТБ",
    "realestate":   "🏠 Недвижимость",
    "land":         "🌍 Земельные участки",
    "transport":    "🚗 Транспорт и спецтехника",
    "equipment":    "⚙️ Станки и оборудование",
    "inventory":    "📦 Инвентарь и хоз. принадлежности",
    "other":        "📋 Другое имущество",
    "rent":         "🔑 Аренда",
    "construction": "🏗️ Проектирование и строительство",
    "share":        "🤝 Доля в собственности",
}


# ════════════════════════════════════════════════════════════
# HTTP К WORKER
# ════════════════════════════════════════════════════════════

def _worker_post(path: str, body: dict) -> dict | None:
    url = f"{cfg.BUTB_WORKER_URL}/{path.lstrip('/')}"
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
            print(f"  [!] Worker POST /{path} ({attempt}/{cfg.REQUEST_RETRIES}): {e}")
            if attempt < cfg.REQUEST_RETRIES:
                time.sleep(cfg.RETRY_BASE_DELAY * attempt)
    return None


def get_soup_get(url: str) -> BeautifulSoup | None:
    """GET страницы через Worker /fetch-page."""
    data = _worker_post("fetch-page", {"url": url})
    if not data:
        return None
    if not data.get("ok"):
        print(f"  [!] fetch-page error: {data.get('error')} (url={url})")
        return None
    if data.get("status", 0) >= 400:
        print(f"  [!] fetch-page HTTP {data['status']} (url={url})")
        return None
    return BeautifulSoup(data["html"], "html.parser")


def get_soup_post(url: str, form_data: str) -> BeautifulSoup | None:
    """POST формы через Worker /fetch-form (пагинация ICEFaces)."""
    data = _worker_post("fetch-form", {"url": url, "form_data": form_data})
    if not data:
        return None
    if not data.get("ok"):
        print(f"  [!] fetch-form error: {data.get('error')}")
        return None
    if data.get("status", 0) >= 400:
        print(f"  [!] fetch-form HTTP {data['status']}")
        return None
    return BeautifulSoup(data["html"], "html.parser")


def pause(base: float) -> None:
    jitter = random.uniform(-cfg.DELAY_JITTER, cfg.DELAY_JITTER)
    time.sleep(max(base + jitter, cfg.DELAY_MINIMUM))


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


# ════════════════════════════════════════════════════════════
# ИЗВЛЕЧЕНИЕ ДАННЫХ ИЗ ФОРМЫ (для пагинации)
# ════════════════════════════════════════════════════════════

def extract_form_state(soup: BeautifulSoup) -> dict:
    """
    Извлекает скрытые поля формы #f_lots для воспроизведения
    ICEFaces-пагинации. ICEFaces использует стандартный POST,
    где ключевые параметры — это javax.faces.ViewState и
    параметры пагинатора.
    """
    form = soup.select_one("#f_lots")
    if not form:
        return {}

    state = {}
    for inp in form.find_all("input", type="hidden"):
        name = inp.get("name", "")
        val  = inp.get("value", "")
        if name:
            state[name] = val

    # Также сохраняем текущее значение page size
    rpp = form.select_one("#yui-pg0-0-rpp")
    if rpp:
        for opt in rpp.find_all("option"):
            if opt.get("selected"):
                state["yui-pg0-0-rpp"] = opt.get("value", "10")
                break

    return state


def build_page_form_data(base_state: dict, page: int) -> str:
    """
    Строит URL-encoded тело формы для запроса страницы N.
    ICEFaces-пагинатор отправляет форму с параметром
    'yui-pg0-0-page' = N (1-based) или обновляет состояние через
    partial submit. Мы используем прямой submit формы.
    """
    params = dict(base_state)
    # Указываем номер запрашиваемой страницы (1-based для ICEFaces PrimeFaces paginator)
    params["yui-pg0-0-page"] = str(page)
    # Имитируем нажатие кнопки пагинатора (partial submit ICEFaces)
    params["javax.faces.partial.ajax"] = "true"
    params["javax.faces.partial.execute"] = "f_lots:tableLot"
    params["javax.faces.partial.render"]  = "f_lots:tableLot"
    params["f_lots:tableLot_paginatorbottom"] = str(page - 1)  # 0-based offset
    return urlencode(params)


def get_total_pages(soup: BeautifulSoup) -> int:
    """Определяет общее число страниц из пагинатора."""
    pag = soup.select_one(".ui-paginator")
    if not pag:
        return 1
    pages = pag.find_all("a", attrs={"page": True})
    if not pages:
        return 1
    try:
        return max(int(a["page"]) for a in pages)
    except (ValueError, TypeError):
        return 1


# ════════════════════════════════════════════════════════════
# ПАРСИНГ ЛОТОВ СО СТРАНИЦЫ ЛИСТИНГА
# ════════════════════════════════════════════════════════════

_LOT_ID_RE = re.compile(r"lotid=(\d+)")
_PRICE_RE  = re.compile(r"[\d\s]+[.,]?\d*")


def _parse_lot_row(row) -> dict | None:
    """Парсит одну строку таблицы лотов (tr.ui-datatable-even/odd)."""

    # Ссылка и lot_id
    link = row.select_one("a.lot-item-descript")
    if not link:
        return None
    href = link.get("href", "")
    m = _LOT_ID_RE.search(href)
    if not m:
        return None

    lot_id = m.group(1)
    # Нормализуем URL: убираем prevPage чтобы был чистый
    url = f"{BASE_URL}/et/lotcard.xhtml?lotid={lot_id}&prevPage=auctions"

    # Статус
    status_el = row.select_one(".lot-status2")
    status    = _clean(status_el.get_text()) if status_el else ""

    # Номер лота и торгов
    titles    = row.select(".lot-item-title")
    lot_num   = _clean(titles[0].get_text()) if len(titles) > 0 else ""
    trade_num = _clean(titles[1].get_text()) if len(titles) > 1 else ""

    # Название лота
    name_el = row.select_one(".lot-name")
    title   = _clean(name_el.get_text()) if name_el else ""

    # Организатор
    org_el    = row.select_one(".lot-item-descript-org-name-descript")
    organizer = _clean(org_el.get_text()) if org_el else ""

    # Адрес
    loc_el   = row.select_one(".lot-item-descript-org-place p")
    location = _clean(loc_el.get_text()) if loc_el else ""

    # Цены и даты из блоков .info-block-value и .info-block-value2
    price_el = row.select_one(".info-block-value")
    price    = ""
    if price_el:
        spans = price_el.find_all("span")
        if spans:
            amount   = _clean(spans[0].get_text())
            currency = _clean(spans[1].get_text()) if len(spans) > 1 else "BYN"
            price    = f"{amount} {currency}".strip()

    # Даты: .info-block-value2 — их несколько (задаток, дедлайн, дата торгов)
    val2_els = row.select(".info-block-value2")
    deposit    = _clean(val2_els[0].get_text()) if len(val2_els) > 0 else ""
    deadline   = _clean(val2_els[1].get_text()) if len(val2_els) > 1 else ""
    trade_date = _clean(val2_els[2].get_text()) if len(val2_els) > 2 else ""

    return {
        "lot_id":     lot_id,
        "url":        url,
        "title":      title,
        "status":     status,
        "lot_num":    lot_num,
        "trade_num":  trade_num,
        "organizer":  organizer,
        "location":   location,
        "price":      price,
        "deposit":    deposit,
        "deadline":   deadline,
        "trade_date": trade_date,
    }


def parse_lots_from_soup(soup: BeautifulSoup) -> list[dict]:
    """Извлекает все лоты со страницы листинга."""
    rows = soup.select("tr.ui-datatable-even, tr.ui-datatable-odd")
    lots = []
    for row in rows:
        lot = _parse_lot_row(row)
        if lot:
            lots.append(lot)
    return lots


def parse_lot_ids_from_soup(soup: BeautifulSoup) -> list[str]:
    """Возвращает только lot_id со страницы (для быстрого сбора снапшота)."""
    rows = soup.select("tr.ui-datatable-even, tr.ui-datatable-odd")
    ids  = []
    for row in rows:
        link = row.select_one("a.lot-item-descript")
        if not link:
            continue
        href = link.get("href", "")
        m    = _LOT_ID_RE.search(href)
        if m:
            ids.append(m.group(1))
    return ids


# ════════════════════════════════════════════════════════════
# ЗАГРУЗКА СТРАНИЦЫ ЛИСТИНГА
# ════════════════════════════════════════════════════════════

def fetch_listing_page(page: int = 1, base_state: dict | None = None) -> BeautifulSoup | None:
    """
    Загружает страницу листинга.
    page=1 → GET (первая страница, нет состояния).
    page>1 → POST формы с состоянием ICEFaces.
    """
    if page == 1 or base_state is None:
        print(f"  → GET страница 1 ({AUCTIONS_URL})")
        return get_soup_get(AUCTIONS_URL)
    else:
        form_data = build_page_form_data(base_state, page)
        print(f"  → POST страница {page}")
        return get_soup_post(AUCTIONS_URL, form_data)


# ════════════════════════════════════════════════════════════
# АЛГОРИТМ НОВЫХ ЛОТОВ
# ════════════════════════════════════════════════════════════

def find_new_lots_by_id(
    fetched_lots: list[dict],
    known_ids: set[str],
    consecutive_known_threshold: int = 3,
) -> list[dict]:
    """
    Возвращает лоты с неизвестными ID.
    Лоты идут в хронологическом порядке (новые — первые).
    Останавливаемся после consecutive_known_threshold известных
    лотов подряд — надёжнее чем break на первом совпадении,
    т.к. в снапшоте могут быть пропуски (удалённые лоты и т.п.).
    """
    new_lots = []
    consecutive = 0
    for lot in fetched_lots:
        lid = lot.get("lot_id", "")
        if not lid:
            continue
        if lid in known_ids:
            consecutive += 1
            if consecutive >= consecutive_known_threshold:
                break
        else:
            consecutive = 0
            new_lots.append(lot)
    return new_lots
  
