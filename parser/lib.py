"""
lib.py — общие функции для snapshot.py и daily.py
"""

import re
import time
import random
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

import config as cfg

BASE_URL = "https://e-auction.by"
# Префикс для хранения ссылок — отрезаем "https://"
URL_PREFIX = "https://"

LOT_TAIL_RE = re.compile(r'^(\d[\d\-]*|im-[\d\-]+)$')

SESSION = requests.Session()
SESSION.headers.update(cfg.REQUEST_HEADERS)


# ════════════════════════════════════════════════════════════
# ССЫЛКИ — хранятся без "https://"
# ════════════════════════════════════════════════════════════

def path_to_stored(path: str) -> str:
    """
    /gos/stanki/961989/  →  e-auction.by/gos/stanki/961989/
    Храним без https:// — браузер откроет и так.
    """
    return "e-auction.by" + path


def stored_to_url(stored: str) -> str:
    """e-auction.by/gos/...  →  https://e-auction.by/gos/..."""
    if stored.startswith("https://"):
        return stored
    return "https://" + stored


def stored_to_path(stored: str) -> str:
    """e-auction.by/gos/stanki/961989/  →  /gos/stanki/961989/"""
    if stored.startswith("https://e-auction.by"):
        return stored[len("https://e-auction.by"):]
    if stored.startswith("e-auction.by"):
        return stored[len("e-auction.by"):]
    return stored


# ════════════════════════════════════════════════════════════
# ПАУЗЫ
# ════════════════════════════════════════════════════════════

def pause(base: float) -> None:
    jitter = random.uniform(-cfg.DELAY_JITTER, cfg.DELAY_JITTER)
    actual = max(base + jitter, cfg.DELAY_MINIMUM)
    time.sleep(actual)


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


# ════════════════════════════════════════════════════════════
# ФИЛЬТРАЦИЯ ПУТЕЙ
# ════════════════════════════════════════════════════════════

def is_lot_path(path: str, section_key: str) -> bool:
    if not path.startswith("/"):
        return False
    for excl in cfg.EXCLUDE_PATH_PREFIXES:
        if path.startswith(excl):
            return False
    segments = path.rstrip("/").split("/")
    if len(segments) < 2:
        return False
    if not LOT_TAIL_RE.match(segments[-1]):
        return False
    if section_key in cfg.ROOTLEVEL_SECTIONS:
        other = tuple(
            cfg.SECTIONS[k] for k in cfg.SECTIONS
            if k not in cfg.ROOTLEVEL_SECTIONS
        )
        return not any(path.startswith(p) for p in other)
    return path.startswith(cfg.SECTIONS[section_key])


# ════════════════════════════════════════════════════════════
# ИЗВЛЕЧЕНИЕ ПУТЕЙ СО СТРАНИЦЫ СПИСКА
# Возвращает stored-формат: "e-auction.by/path/"
# ════════════════════════════════════════════════════════════

def extract_lot_paths(soup: BeautifulSoup, section_key: str) -> list[str]:
    paths, seen = [], set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.startswith("https://e-auction.by"):
            path = href[len("https://e-auction.by"):]
        elif href.startswith("/"):
            path = href
        else:
            continue
        path = path.split("?")[0].split("#")[0]
        if not path.endswith("/"):
            path += "/"
        stored = path_to_stored(path)
        if stored not in seen and is_lot_path(path, section_key):
            seen.add(stored)
            paths.append(stored)
    return paths


# ════════════════════════════════════════════════════════════
# ПАГИНАЦИЯ
# ════════════════════════════════════════════════════════════

def get_next_page_url(soup: BeautifulSoup, current_url: str) -> str | None:
    cur = 1
    if "PAGEN_1=" in current_url:
        try:
            cur = int(current_url.split("PAGEN_1=")[1].split("&")[0])
        except ValueError:
            pass
    for a in soup.find_all("a", href=True):
        cls  = " ".join(a.get("class", []))
        text = a.get_text(strip=True)
        if any(x in cls for x in ["next", "forward", "arr_right"]) \
                or text in (">", "»", "Следующая", "Вперед"):
            return urljoin(BASE_URL, a["href"])
    for a in soup.find_all("a", href=True):
        if f"PAGEN_1={cur + 1}" in a["href"]:
            return urljoin(BASE_URL, a["href"])
    return None


def build_section_url(section_path: str, section_key: str, page: int = 1) -> str:
    sort = cfg.SECTION_SORT_PARAM.get(section_key, "")
    params = []
    if sort:
        params.append(sort)
    if page > 1:
        params.append(f"PAGEN_1={page}")
    url = BASE_URL + section_path
    if params:
        url += "?" + "&".join(params) + "&"
    return url


# ════════════════════════════════════════════════════════════
# АЛГОРИТМ ОПРЕДЕЛЕНИЯ НОВЫХ ЛОТОВ
# ════════════════════════════════════════════════════════════

def find_new_lots(
    daily_paths: list[str],
    snapshot: dict[str, int],
    seq_window: int = None,
    seq_min_matches: int = None,
) -> list[str]:
    """
    daily_paths  — список stored-путей из дневного парсинга
    snapshot     — {stored_path: rank} из KV
    Возвращает список новых stored-путей.
    """
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
        window = daily_paths[i + 1 : i + 1 + seq_window]

        window_known = [
            (snapshot[w], w)
            for w in window
            if w in snapshot
        ]

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
            print(f"  [⏹] Стоп: {matches} совпадений последовательности на «{path}»")
            break
        else:
            new_paths.append(path)
            i += 1

    return new_paths


# ════════════════════════════════════════════════════════════
# ПАРСИНГ КАТЕГОРИЙ АУКЦИОНА
# ════════════════════════════════════════════════════════════

def parse_auction_categories() -> list[dict]:
    """
    Парсит список верхнеуровневых категорий аукциона из sidebar главной страницы.
    Возвращает: [{"slug": "legkovye_avtomobili", "label": "Легковые автомобили"}, ...]

    Sidebar содержит единый каталог категорий, общий для auction/commerce/gos.
    Берём только верхний уровень (depth-level-1) — slug-и из URL без раздела,
    они одинаково применимы ко всем аукционным разделам.
    """
    print("[→] Парсю категории аукциона с главной страницы…")
    soup = get_soup(BASE_URL + "/")
    if soup is None:
        print("[!] Не удалось загрузить главную, категории не обновлены")
        return []

    categories = []
    seen_slugs: set[str] = set()

    # Sidebar: ul.dropdown-menu.template_catalog
    catalog_ul = soup.find("ul", class_=lambda c: c and "template_catalog" in c)
    if catalog_ul is None:
        print("[!] Sidebar каталога не найден")
        return []

    for li in catalog_ul.find_all("li", recursive=False):
        a = li.find("a", href=True)
        if not a:
            continue

        href = a["href"]
        # Ссылки вида https://e-auction.by/slug/ или /slug/
        if href.startswith(BASE_URL):
            path = href[len(BASE_URL):]
        elif href.startswith("/"):
            path = href
        else:
            continue

        path = path.strip("/")
        # Пропускаем служебные пути и пути не являющиеся slug-ами категорий
        if not path or "/" in path:
            continue
        skip = {"", "auction", "commerce", "gos", "shop", "showcase",
                "register-of-failed-auctions", "register-revaluation",
                "uslugi", "info", "contacts", "personal", "basket"}
        if path in skip or path.startswith("register"):
            continue

        label = _clean(a.get_text())
        if not label or len(label) > 80:
            continue

        # Убираем «стрелочку» SVG из текста (если есть)
        label = re.sub(r'\s+', ' ', label).strip()

        if path not in seen_slugs:
            seen_slugs.add(path)
            categories.append({"slug": path, "label": label})

    print(f"[✓] Найдено категорий: {len(categories)}")
    for c in categories:
        print(f"    {c['label']:50s} → {c['slug']}")
    return categories


# ════════════════════════════════════════════════════════════
# ПАРСИНГ ДЕТАЛЕЙ ЛОТА
# ════════════════════════════════════════════════════════════

def _clean(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def _clean_title(raw: str) -> str:
    """Убирает служебные суффиксы из заголовка."""
    TRASH = [
        "Имущество государственной формы собственности",
        "Имущество частной формы собственности",
        "Повторные торги",
        "Интернет-магазин",
        "Интернет-витрина",
    ]
    title = _clean(raw)
    for phrase in TRASH:
        idx = title.find(phrase)
        if idx != -1:
            title = title[:idx].strip()
    return title


def _all_table_rows(soup: BeautifulSoup) -> list[tuple[str, str, str]]:
    """
    Возвращает все строки всех таблиц как (section_name, key, value).
    section_name — текст ближайшего предыдущего h3/h4 (или "" если нет).
    """
    rows = []
    for table in soup.find_all("table", class_="product-specs__table"):
        prev_h = table.find_previous_sibling(["h3", "h4"])
        section = _clean(prev_h.get_text()) if prev_h else ""
        for row in table.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) >= 2:
                key = _clean(cells[0].get_text())
                val = _clean(cells[1].get_text())
                if key or val:
                    rows.append((section, key, val))
    return rows


def _extract_price(soup: BeautifulSoup) -> str:
    """Ищет цену: span.current-bid → таблица «начальная» → текст."""
    # 1. span.current-bid
    el = soup.select_one("span.current-bid, .current-bid span")
    if el:
        m = re.search(r'([\d][\d\s]*[.,]\d{2}\s*BYN)', _clean(el.get_text()))
        if m:
            return _clean(m.group(1))

    # 2. Таблица: ключ содержит "начальная" + ("стоимость" или "цена")
    for _, key, val in _all_table_rows(soup):
        kl = key.lower()
        if "начальная" in kl and ("стоимость" in kl or "цена" in kl):
            m = re.search(r'([\d][\d\s]*[.,]\d{2}\s*BYN)', val)
            if m:
                return _clean(m.group(1))

    # 2b. Таблица: ключ == «стоимость» / «цена» / «цена товара» (shop/showcase)
    for _, key, val in _all_table_rows(soup):
        kl = key.lower().strip()
        if kl in ("стоимость", "цена", "цена товара", "стоимость товара",
                  "цена (byn)", "стоимость (byn)"):
            # Ищем число: может быть "280,00 BYN", "280 BYN", "280.00 BYN", просто "280"
            m = re.search(r'([\d][\d\s]*[.,]?\d*\s*(?:BYN|р\.?|руб\.?))', val, re.I)
            if m:
                raw = _clean(m.group(1))
                # Нормализуем: если нет BYN — добавляем
                if not re.search(r'BYN', raw, re.I):
                    raw = re.sub(r'\s*(р\.?|руб\.?)$', '', raw).strip() + ' BYN'
                return raw
            # Если значение — просто число
            m2 = re.search(r'^[\d][\d\s]*[.,]?\d*$', val.strip())
            if m2:
                return val.strip() + ' BYN'

    # 3. CSS-классы — расширенный список включая showcase/shop специфику
    for sel in [".lot-price", ".detail-price", ".auction-price", ".price-value",
                ".product-price", ".showcase-price", ".item-price",
                ".price-shop", ".price-shop.large"]:
        el = soup.select_one(sel)
        if el:
            t = _clean(el.get_text())
            if "справочно" in t.lower():
                continue
            # Диапазон цен "120,00 - 320,00 BYN" → берём первое число
            m = re.search(r'([\d][\d\s]*[.,]\d{2})\s*(?:-\s*[\d][\d\s]*[.,]\d{2}\s*)?BYN', t, re.I)
            if m:
                return _clean(m.group(1)) + " BYN"
            m = re.search(r'([\d][\d\s]*[.,]\d{2}\s*BYN)', t)
            if m:
                return _clean(m.group(1))

    # 3b. data-price атрибут (showcase: <div class="bx_price price" data-price="240">)
    el = soup.select_one("[data-price]")
    if el:
        val = el.get("data-price", "").strip()
        if val and re.match(r'^[\d.,\s]+$', val):
            try:
                num = float(val.replace(",", ".").replace(" ", ""))
                if num > 0:
                    return f"{num:,.2f}".replace(",", " ") + " BYN"
            except ValueError:
                pass

    # 4. Первое «N... BYN» в тексте без «справочно»
    for line in soup.get_text("\n").splitlines():
        line = line.strip()
        if not line or "справочно" in line.lower():
            continue
        # Пробуем: число с копейками
        m = re.search(r'([\d][\d\s]*[.,]\d{2}\s*BYN)', line)
        if m:
            return _clean(m.group(1))
        # Пробуем: число без копеек + BYN
        m = re.search(r'([\d][\d\s]*\s*BYN)', line, re.I)
        if m:
            return _clean(m.group(1))

    return ""


def _extract_location(rows: list[tuple]) -> str:
    """
    Ищет местоположение/адрес в строках таблиц.
    Приоритет: «Местоположение имущества» > «Адрес» (только первый, не организатора).
    """
    loc_exact = ""   # "Местоположение имущества"
    loc_addr  = ""   # "Адрес" — но не "Адрес организатора"

    for section, key, val in rows:
        kl = key.lower()
        sl = section.lower()

        # Пропускаем строки из служебных секций
        if any(x in sl for x in ["продавец", "оператор", "организатор"]):
            continue

        if "местоположение имущества" in kl or "местонахождение имущества" in kl:
            if not loc_exact:
                loc_exact = val
        elif kl == "адрес" and not loc_addr:
            loc_addr = val

    return loc_exact or loc_addr


def _extract_area(rows: list[tuple]) -> str:
    for _, key, val in rows:
        if "площадь" in key.lower() and val:
            return val
    return ""


# Фразы-мусор которые не несут смысловой нагрузки в описании лота
_GARBAGE_PHRASES = (
    "местоположение имущества",
    "местонахождение имущества",
    "оплата и оформление заказов",
    "оплата и оформление",
    "условия оплаты",
    "оформление заказа",
    "контактная информация",
    "обращаем внимание",
    "самовывоз",
)

def _is_garbage_line(text: str) -> bool:
    """Возвращает True если строка — служебный мусор, не нужный в описании."""
    tl = text.lower().strip()
    return any(tl.startswith(p) or tl == p for p in _GARBAGE_PHRASES)


def _extract_description(soup: BeautifulSoup, location: str, section: str = "") -> str:
    """
    Описание берём из секции «Предмет торгов» (таблица после h3).
    Если такой секции нет — из поля «Описание» или «Информация» в таблице.
    Местоположение из описания исключаем (оно уже в отдельном поле).
    """
    # Вариант A: секция «Предмет торгов» (gos и auction)
    for h3 in soup.find_all("h3"):
        if "предмет торгов" in h3.get_text().lower():
            table = h3.find_next_sibling("table")
            if table:
                lines = []
                for row in table.find_all("tr"):
                    cells = row.find_all(["td", "th"])
                    if len(cells) < 2:
                        continue
                    key = _clean(cells[0].get_text())
                    val = _clean(cells[1].get_text())
                    if not key or not val:
                        continue
                    # Пропускаем строку с местоположением — оно уже в location
                    if "местоположение имущества" in key.lower() or \
                       "местонахождение имущества" in key.lower():
                        continue
                    lines.append(f"{key}\t{val}")
                if lines:
                    return "\n".join(lines)

    # Вариант B: поле «Описание» в любой таблице (commerce)
    for _, key, val in _all_table_rows(soup):
        if key.lower() == "описание" and val:
            return val

    # Вариант C: shop/showcase — строки «Информация» и «Б/у...» (только для этих разделов)
    # Берём текст однострочных строк таблицы до строки «Склад»/«Магазин»
    if section not in ("shop", "showcase"):
        return ""
    for table in soup.find_all("table", class_="product-specs__table"):
        lines = []
        for row in table.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) == 1:
                val = _clean(cells[0].get_text())
                # Пропускаем служебные заголовки и мусорные строки
                _SKIP_SINGLE = {
                    "Информация", "Склад", "Магазин", "Обращаем внимание",
                    "Местоположение имущества", "Местонахождение имущества",
                    "Оплата и оформление заказов", "Оплата и оформление",
                    "Оформление заказа", "Доставка", "Самовывоз",
                    "Условия оплаты", "Условия доставки",
                    "Контактная информация", "Контакты",
                }
                if val and val not in _SKIP_SINGLE and not _is_garbage_line(val):
                    lines.append(val)
            elif len(cells) >= 2:
                key = _clean(cells[0].get_text()).lower()
                # Как только дошли до адреса/телефона/служебных строк — стоп
                if key in ("адрес", "время работы", "контактный телефон",
                           "склад", "магазин", "обращаем внимание",
                           "местоположение имущества",
                           "местонахождение имущества",
                           "оплата и оформление заказов",
                           "оплата и оформление",
                           "условия оплаты", "доставка"):
                    break
        if lines:
            return "\n".join(lines)

    return ""


def parse_lot_details(stored_path: str, section: str = "") -> dict:
    """
    Открывает страницу лота.
    Принимает stored_path ("e-auction.by/...") или обычный path ("/...").
    Возвращает dict с полями: url, title, price, location, description, area.
    """
    url = stored_to_url(stored_path)
    soup = get_soup(url)

    empty = {
        "url": url, "title": "",
        "price": "", "location": "",
        "description": "", "area": "",
    }
    if soup is None:
        empty["title"] = stored_path
        return empty

    d = dict(empty)

    # Название
    for sel in ["h1.lot-title", "h1.detail-title", ".lot-card__title",
                ".auction-detail__title", ".product-detail-title", "h1"]:
        el = soup.select_one(sel)
        if el:
            d["title"] = _clean_title(el.get_text())
            break

    # Собираем все строки таблиц один раз
    rows = _all_table_rows(soup)

    d["price"]    = _extract_price(soup)
    d["location"] = _extract_location(rows)
    d["area"]     = _extract_area(rows)
    d["description"] = _extract_description(soup, d["l
