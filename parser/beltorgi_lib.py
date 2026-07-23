"""
beltorgi_lib.py — парсер beltorgi.by (ЗАО «Белреализация» — торги по банкротству)

Как и gostorg.by, запросы идут через Cloudflare Worker:

  POST {WORKER}/fetch-page  {url}  → {ok, status, html}

Главная страница (https://beltorgi.by/) отдаёт карточки лотов сразу в HTML
(без пагинации), но:
  - карточки повторяются (несколько виджетов на странице показывают
    пересекающиеся наборы лотов) — нужна дедупликация по lot_id;
  - порядок карточек НЕ гарантированно "новые сверху" (похоже на подборку
    "хиты"/рекомендации, а не строгую ленту по дате) — поэтому в отличие
    от gostorg.by здесь daily-парсер сравнивает весь снятый (дедуп.) набор
    целиком со списком известных id, без покарточного "стоп после N
    известных подряд".

Два типа карточек на странице:
  - "Электронные торги" — есть номер лота (Лот №NNNNN) и дедлайн
    (data-deadline на .jsdedline)
  - "Продажа без аукциона" / магазин — нет ни номера лота, ни дедлайна

Структура карточки (из реального HTML):
  <div class="card h-100">
    <div class="card-img-top position-relative" data-id="144020">
      <div class="discont">-80%</div>                      (если есть скидка)
      <div class="clock ..."><div class="jsdedline" data-deadline="Thu Aug 6 16:00:00 +03 2026">...</div></div>
      <a href="https://beltorgi.by/....html" title="Название лота">...</a>
    </div>
    <div class="card-body p-3">
      <img title="Электронные торги" />  Лот №31873
      <div class="text-black-50"><i class="bi bi-geo-alt"></i> Гомельская обл.</div>
      <div class="card-title"><a href="...">Название лота</a></div>
    </div>
    <div class="card-footer">
      <span class="old_price">750 000,00 бел. руб.</span>   (если есть скидка)
      <span class="price">150 000,00 бел. руб.</span>
    </div>
  </div>

lot_id берётся из data-id контейнера — стабильный числовой идентификатор.
"""

import re
import time
import requests
from bs4 import BeautifulSoup

import config as cfg

BASE_URL = "https://beltorgi.by"

_SESSION = requests.Session()


# ════════════════════════════════════════════════════════════
# HTTP К WORKER
# ════════════════════════════════════════════════════════════

def _worker_post(path: str, body: dict) -> dict | None:
    url = f"{cfg.BELTORGI_WORKER_URL}/{path.lstrip('/')}"
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


def get_soup(url: str) -> BeautifulSoup | None:
    """GET страницы через Worker /fetch-page, с ретраем на 5xx (см. gostorg_lib)."""
    for attempt in range(1, cfg.REQUEST_RETRIES + 1):
        data = _worker_post("fetch-page", {"url": url})
        if not data:
            return None
        if not data.get("ok"):
            print(f"  [!] fetch-page error: {data.get('error')} (url={url})")
            return None

        status = data.get("status", 0)
        if status >= 500:
            print(f"  [!] fetch-page HTTP {status} ({attempt}/{cfg.REQUEST_RETRIES}, url={url})")
            if attempt < cfg.REQUEST_RETRIES:
                time.sleep(cfg.RETRY_BASE_DELAY * attempt)
                continue
            return None
        if status >= 400:
            print(f"  [!] fetch-page HTTP {status} (url={url})")
            return None

        return BeautifulSoup(data["html"], "html.parser")
    return None


# ════════════════════════════════════════════════════════════
# ПАРСИНГ ГЛАВНОЙ СТРАНИЦЫ
# ════════════════════════════════════════════════════════════

def _parse_card(card) -> dict | None:
    id_el = card.select_one(".card-img-top.position-relative[data-id]")
    if not id_el:
        return None
    lot_id = id_el["data-id"]

    link = card.select_one("a[href]")
    if not link or not link.get("href"):
        return None
    url = link["href"]

    title_el = card.select_one(".card-title a")
    title = (title_el.get("title") or title_el.get_text(strip=True)) if title_el \
        else (link.get("title") or "Без названия")

    loc_el = card.select_one(".card-body .text-black-50")
    location = loc_el.get_text(strip=True) if loc_el else ""

    deadline_el = card.select_one(".jsdedline")
    deadline = deadline_el.get("data-deadline") if deadline_el else None

    lot_num = None
    body = card.select_one(".card-body")
    if body:
        m = re.search(r"Лот\s*№\s*\d+", body.get_text(" ", strip=True))
        if m:
            lot_num = m.group(0)

    discount_el = card.select_one(".discont")
    discount_percent = None
    if discount_el:
        dm = re.search(r"(\d+)", discount_el.get_text())
        if dm:
            discount_percent = int(dm.group(1))

    price_el = card.select_one(".price")
    price = price_el.get_text(" ", strip=True) if price_el else ""

    old_price_el = card.select_one(".old_price")
    old_price = old_price_el.get_text(" ", strip=True) if old_price_el else ""

    return {
        "lot_id":           lot_id,
        "url":              url,
        "title":            title,
        "location":         location,
        "lot_num":          lot_num,
        "deadline":         deadline,
        "discount_percent": discount_percent,
        "price":            price,
        "old_price":        old_price,
        "is_auction":       deadline_el is not None,
    }


def parse_listing() -> list[dict]:
    """
    Парсит главную страницу beltorgi.by и возвращает дедуплицированный
    (по lot_id) список лотов. Порядок соответствует порядку на странице,
    но НЕ гарантированно "новые сверху" — не полагайтесь на позицию.
    """
    soup = get_soup(BASE_URL)
    if soup is None:
        return []

    seen: set[str] = set()
    lots: list[dict] = []
    for card in soup.select(".card.h-100"):
        lot = _parse_card(card)
        if not lot or lot["lot_id"] in seen:
            continue
        seen.add(lot["lot_id"])
        lots.append(lot)

    print(f"  Снято уникальных карточек: {len(lots)}")
    return lots
