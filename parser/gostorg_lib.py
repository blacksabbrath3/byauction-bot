"""
gostorg_lib.py — парсер gostorg.by (Госторг РБ — электронные торги имущества)

Сайт на Bitrix, прямой доступ с GitHub IP не проверялся как надёжный,
поэтому (по аналогии с butb/eauction/torgigov) запросы идут через
Cloudflare Worker:

  POST {WORKER}/fetch-page  {url}  → {ok, status, html}

Последние лоты показаны прямо на главной странице (https://gostorg.by/),
самые новые — сверху. Пагинация не нужна: достаточно снимать верхние
GOSTORG_SNAPSHOT_LIMIT карточек.

Структура карточки (из реального HTML):
  <li class="auction-list__item" id="bx_..._<...>">
    <div class="auction-list__link">
      <a class="auction-list__img" href="https://gostorg.by/catalog/.../<slug>/">
        <img ... />
        <div class="tooltip auction-card__image-title">
          <span class="auction-card__image-element">... 20.08.2026</span>
          <div class="tooltip-text">Электронные торги</div>
        </div>
      </a>
      <div class="auction-card__tags">
        <span class="auction-card__tag tag__background-new-lot">New</span>
        <span class="auction-card__tag tag__background-discount-price">-30%</span>
      </div>
      <div class="auction-list__text">
        <div class="auction-card__price">30 360,00 BYN</div>
        <div class="auction-card__title"><a href="..."><h6>Название</h6></a></div>
        <div class="auction-card__content">
          <div class="auction-card__properties">Описание...</div>
          <div class="auction-card__location">
            <button data-src="...LOCATION_ADDRESS=Адрес...">...</button>
            <button ...>Адрес текстом</button>
          </div>
        </div>
      </div>
    </div>
  </li>

lot_id берётся из последнего непустого сегмента пути URL (устойчивый
уникальный слаг), а не из id="bx_..._N" контейнера.
"""

import re
import time
import random
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse

import config as cfg

BASE_URL = "https://gostorg.by"

_SESSION = requests.Session()


# ════════════════════════════════════════════════════════════
# HTTP К WORKER
# ════════════════════════════════════════════════════════════

def _worker_post(path: str, body: dict) -> dict | None:
    url = f"{cfg.GOSTORG_WORKER_URL}/{path.lstrip('/')}"
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


# ════════════════════════════════════════════════════════════
# ПАРСИНГ ГЛАВНОЙ СТРАНИЦЫ
# ════════════════════════════════════════════════════════════

def _lot_id_from_url(url: str) -> str:
    """Последний непустой сегмент пути — стабильный уникальный слаг лота."""
    path = urlparse(url).path.rstrip("/")
    return path.rsplit("/", 1)[-1] if path else url


def _extract_auction_date(card) -> str:
    """Дата из тултипа обложки ('... 20.08.2026') — только сама дата."""
    el = card.select_one(".auction-card__image-element")
    if not el:
        return ""
    m = re.search(r"\d{2}\.\d{2}\.\d{4}", el.get_text(" ", strip=True))
    return m.group(0) if m else ""


def _extract_location(card) -> str:
    """Второй <button> в .auction-card__location содержит адрес текстом."""
    loc = card.select_one(".auction-card__location")
    if not loc:
        return ""
    buttons = loc.select("button")
    if len(buttons) >= 2:
        text = buttons[1].get_text(" ", strip=True)
        if text:
            return text
    # fallback — из data-src query-параметра LOCATION_ADDRESS
    for btn in buttons:
        src = btn.get("data-src", "")
        m = re.search(r"LOCATION_ADDRESS=([^&]+)", src)
        if m:
            from urllib.parse import unquote
            return unquote(m.group(1))
    return ""


def _extract_discount(card) -> int | None:
    tag = card.select_one(".tag__background-discount-price")
    if not tag:
        return None
    m = re.search(r"(\d+)", tag.get_text(strip=True))
    return int(m.group(1)) if m else None


def parse_listing(limit: int = None) -> list[dict]:
    """
    Парсит главную страницу gostorg.by и возвращает список лотов
    (самые новые — первыми, как на сайте).

    Один HTTP-запрос отдаёт сразу всю ленту, которая есть в DOM
    (на практике — сотни карточек, без AJAX-подгрузки и пагинации),
    поэтому `limit` — это просто опциональная обрезка уже полученного
    списка (используется снапшотом, которому нужны только верхние 20),
    а не параметр для повторных запросов.
    """
    soup = get_soup(BASE_URL)
    if soup is None:
        return []

    cards = soup.select(".auction-list__item")
    if limit:
        cards = cards[:limit]
    lots = []

    for card in cards:
        link = card.select_one("a.auction-list__img") or card.select_one("a.auction-list__title")
        if not link or not link.get("href"):
            continue
        url = link["href"]
        if not url.startswith("http"):
            url = BASE_URL + url

        title_el = card.select_one(".auction-card__title h6")
        title = title_el.get_text(strip=True) if title_el else "Без названия"

        price_el = card.select_one(".auction-card__price")
        price = price_el.get_text(strip=True) if price_el else ""

        desc_el = card.select_one(".auction-card__properties")
        description = desc_el.get_text(" ", strip=True) if desc_el else ""

        lots.append({
            "lot_id":           _lot_id_from_url(url),
            "url":              url,
            "title":            title,
            "price":            price,
            "location":         _extract_location(card),
            "description":      description,
            "is_new":           card.select_one(".tag__background-new-lot") is not None,
            "discount_percent": _extract_discount(card),
            "auction_date":     _extract_auction_date(card),
        })

    print(f"  Снято карточек: {len(lots)}")
    return lots
