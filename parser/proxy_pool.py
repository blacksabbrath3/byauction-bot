"""
proxy_pool.py — пул RU/BY прокси для обхода гео-блокировки

Источники прокси (в порядке приоритета):
  1. roosterkid/HTTPS.txt  — формат: FLAG IP:PORT Xms CC [ISP]
  2. proxifly RU http      — формат: http://IP:PORT  (уже страна=RU)
  3. proxifly RU JSON      — формат: JSON с полем geolocation.country
  4. TheSpeedX/http.txt    — формат: IP:PORT (без страны; валидируем через ipinfo.io)

Добавить ещё источники → PROXY_SOURCES в config.py или прямо в список ниже.

Алгоритм:
  1. build_pool()  — обходит источники по порядку, парсит, фильтрует RU/BY,
                    возвращает перемешанный список {host, port, cc, source}.
  2. get_session() — возвращает requests.Session() с настроенным прокси.
  3. fetch_with_proxy(url) — пробует прокси по одному, при ошибке ротирует.
"""

import re
import json
import time
import random
import requests
import ipaddress
from urllib.parse import urlparse

import config as cfg


class ProxyPoolExhausted(Exception):
    """Все прокси из пула испробованы и ни один не сработал."""

# ── Настройка таймаутов ────────────────────────────────────
FETCH_TIMEOUT    = 12   # сек — таймаут загрузки одного источника прокси
PROXY_TIMEOUT    = 20   # сек — таймаут HTTP-запроса через прокси
VALIDATE_TIMEOUT = 8    # сек — таймаут быстрой проверки прокси
TEST_URL         = "https://torgi.gov.by/robots.txt"  # лёгкая цель для валидации

# Страны, прокси которых принимаем
ALLOWED_CC = {"RU", "BY"}

# ── Паттерны парсинга ──────────────────────────────────────
# roosterkid: "🇷🇺 1.2.3.4:8080 400ms RU [ISP]"
_ROOSTERKID_RE = re.compile(
    r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})\s+\S+\s+(RU|BY)\b"
)
# URL-формат: "http://1.2.3.4:8080" или "https://1.2.3.4:8080"
_URL_FORMAT_RE = re.compile(
    r"https?://(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})"
)
# Голый IP:PORT
_IPPORT_RE = re.compile(
    r"^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})$"
)


def _is_valid_ip(ip: str) -> bool:
    try:
        obj = ipaddress.ip_address(ip)
        return not (obj.is_private or obj.is_loopback or obj.is_unspecified)
    except ValueError:
        return False


# ════════════════════════════════════════════════════════════
# ПАРСЕРЫ ИСТОЧНИКОВ
# ════════════════════════════════════════════════════════════

def _parse_roosterkid(text: str, source: str) -> list[dict]:
    """Формат: FLAG IP:PORT Xms CC [ISP]  — страна указана явно."""
    proxies = []
    for m in _ROOSTERKID_RE.finditer(text):
        ip, port, cc = m.group(1), m.group(2), m.group(3)
        if _is_valid_ip(ip):
            proxies.append({"host": ip, "port": int(port), "cc": cc, "source": source})
    return proxies


def _parse_proxifly_txt(text: str, cc: str, source: str) -> list[dict]:
    """Формат: http://IP:PORT  (страна берётся из URL источника)."""
    proxies = []
    for m in _URL_FORMAT_RE.finditer(text):
        ip, port = m.group(1), m.group(2)
        if _is_valid_ip(ip):
            proxies.append({"host": ip, "port": int(port), "cc": cc, "source": source})
    return proxies


def _parse_proxifly_json(text: str, source: str) -> list[dict]:
    """Формат: [{proxy, protocol, ip, port, geolocation: {country}}]"""
    proxies = []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return proxies
    for entry in data:
        if not isinstance(entry, dict):
            continue
        cc = entry.get("geolocation", {}).get("country", "")
        if cc not in ALLOWED_CC:
            continue
        proto = entry.get("protocol", "http").lower()
        if proto not in ("http", "https"):
            continue
        ip   = entry.get("ip", "")
        port = entry.get("port", 0)
        if ip and port and _is_valid_ip(ip):
            proxies.append({"host": ip, "port": int(port), "cc": cc, "source": source})
    return proxies


def _parse_generic_ipport(text: str, cc: str, source: str) -> list[dict]:
    """Голые IP:PORT — страна передаётся явно (заранее известна)."""
    proxies = []
    for line in text.splitlines():
        line = line.strip()
        m = _IPPORT_RE.match(line)
        if m and _is_valid_ip(m.group(1)):
            proxies.append({
                "host": m.group(1), "port": int(m.group(2)),
                "cc": cc, "source": source,
            })
    return proxies


# ════════════════════════════════════════════════════════════
# ЗАГРУЗКА ОДНОГО ИСТОЧНИКА
# ════════════════════════════════════════════════════════════

def _fetch_text(url: str) -> str | None:
    try:
        r = requests.get(url, timeout=FETCH_TIMEOUT,
                         headers={"User-Agent": "Mozilla/5.0 proxy-fetcher/1.0"})
        if r.status_code == 200:
            return r.text
        print(f"    [!] {url} → HTTP {r.status_code}")
    except requests.RequestException as e:
        print(f"    [!] {url} → {e}")
    return None


# ════════════════════════════════════════════════════════════
# ОПИСАНИЕ ИСТОЧНИКОВ
# Каждый источник — dict с полями:
#   url      — адрес для загрузки
#   parser   — callable(text) → [proxy_dict]
#   cc       — код страны (если определяется источником — None)
# ════════════════════════════════════════════════════════════

def _make_sources() -> list[dict]:
    """
    Собирает список источников.
    Кастомные URL берём из config.PROXY_EXTRA_SOURCES (список строк вида
    'roosterkid|https://...' или 'ipport_RU|https://...' или 'ipport_BY|https://...').
    """
    sources = [
        # ── Источник 1: roosterkid — с флагами стран ─────────────
        {
            "url": "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS.txt",
            "parser": lambda t: _parse_roosterkid(t, "roosterkid"),
        },
        # ── Источник 2: proxifly RU HTTP (plaintext) ─────────────
        {
            "url": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/RU/data.txt",
            "parser": lambda t: _parse_proxifly_txt(t, "RU", "proxifly_RU"),
        },
        # ── Источник 3: proxifly RU JSON (с геолокацией) ─────────
        {
            "url": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/RU/data.json",
            "parser": lambda t: _parse_proxifly_json(t, "proxifly_RU_json"),
        },
        # ── Источник 4: proxifly BY HTTP (plaintext) ─────────────
        {
            "url": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/BY/data.txt",
            "parser": lambda t: _parse_proxifly_txt(t, "BY", "proxifly_BY"),
        },
    ]

    # Дополнительные источники из config (если добавлены)
    for entry in getattr(cfg, "PROXY_EXTRA_SOURCES", []):
        try:
            kind, url = entry.split("|", 1)
            kind = kind.strip().lower()
            url  = url.strip()
            if kind == "roosterkid":
                sources.append({"url": url, "parser": lambda t, u=url: _parse_roosterkid(t, u)})
            elif kind.startswith("ipport_"):
                cc = kind.split("_", 1)[1].upper()
                sources.append({"url": url, "parser": lambda t, c=cc, u=url: _parse_generic_ipport(t, c, u)})
            elif kind == "proxifly_json":
                sources.append({"url": url, "parser": lambda t, u=url: _parse_proxifly_json(t, u)})
        except Exception as e:
            print(f"  [!] PROXY_EXTRA_SOURCES: неверный формат '{entry}': {e}")

    return sources


# ════════════════════════════════════════════════════════════
# ПОСТРОЕНИЕ ПУЛА
# ════════════════════════════════════════════════════════════

def build_pool() -> list[dict]:
    """
    Загружает и парсит все источники прокси.
    Возвращает перемешанный список RU/BY proxy_dict.
    Не бросает исключений — при отказе всех источников возвращает [].
    """
    print("[→] Собираю пул RU/BY прокси…")
    pool: list[dict] = []
    seen: set[tuple] = set()

    for src_def in _make_sources():
        url = src_def["url"]
        print(f"  → {url}")
        text = _fetch_text(url)
        if text is None:
            print(f"    [✗] Источник недоступен, пропускаю")
            continue

        candidates = src_def["parser"](text)
        added = 0
        for p in candidates:
            key = (p["host"], p["port"])
            if key not in seen:
                seen.add(key)
                pool.append(p)
                added += 1
        print(f"    [✓] +{added} прокси (RU/BY)")

    random.shuffle(pool)
    print(f"[✓] Пул: {len(pool)} уникальных RU/BY прокси")
    return pool


# ════════════════════════════════════════════════════════════
# ВАЛИДАЦИЯ ПРОКСИ
# ════════════════════════════════════════════════════════════

def _proxy_url(p: dict) -> str:
    return f"http://{p['host']}:{p['port']}"


def validate_proxy(p: dict) -> bool:
    """Быстрая проверка: отвечает ли прокси на запрос к torgi.gov.by."""
    purl = _proxy_url(p)
    try:
        r = requests.get(
            TEST_URL,
            proxies={"http": purl, "https": purl},
            timeout=VALIDATE_TIMEOUT,
            headers={"User-Agent": cfg.REQUEST_HEADERS.get("User-Agent", "Mozilla/5.0")},
        )
        return r.status_code < 500
    except Exception:
        return False


# ════════════════════════════════════════════════════════════
# СЕССИЯ С ПРОКСИ + РОТАЦИЯ
# ════════════════════════════════════════════════════════════

class ProxySession:
    """
    Обёртка над requests.Session, которая автоматически ротирует
    прокси при ошибке соединения.

    Использование:
        ps = ProxySession()
        resp = ps.get("https://torgi.gov.by/...")
        soup = BeautifulSoup(resp.text, "html.parser")
    """

    def __init__(self):
        self._pool: list[dict] = []
        self._idx: int = 0
        self._current: dict | None = None
        self._session = requests.Session()
        self._session.headers.update(cfg.REQUEST_HEADERS)
        self._load_pool()

    # ── Внутренние ────────────────────────────────────────

    def _load_pool(self) -> None:
        self._pool = build_pool()
        self._idx  = 0
        if not self._pool:
            print("[!] ProxySession: пул пуст — работаю без прокси")
        else:
            self._apply_proxy(self._pool[0])

    def _apply_proxy(self, p: dict) -> None:
        purl = _proxy_url(p)
        self._session.proxies = {"http": purl, "https": purl}
        self._current = p

    def _next_proxy(self) -> None:
        """
        Переключает на следующий прокси.
        Бросает ProxyPoolExhausted если список кончился.
        """
        self._idx += 1
        if self._idx >= len(self._pool):
            raise ProxyPoolExhausted(
                f"Исчерпаны все {len(self._pool)} прокси из пула"
            )
        self._apply_proxy(self._pool[self._idx])

    # ── Публичный интерфейс ───────────────────────────────

    def get(self, url: str, **kwargs) -> requests.Response:
        """
        GET с автоматической ротацией прокси.
        При ConnectionError/ProxyError/Timeout/SSLError пробует следующий
        прокси до MAX_PROXY_RETRIES раз, затем бросает ProxyPoolExhausted.
        """
        kwargs.setdefault("timeout", PROXY_TIMEOUT)
        max_retries = getattr(cfg, "MAX_PROXY_RETRIES", 15)

        for attempt in range(1, max_retries + 1):
            proxy_str = _proxy_url(self._current) if self._current else "без прокси"
            try:
                r = self._session.get(url, **kwargs)
                if r.status_code < 500:
                    return r
                r.raise_for_status()
            except (
                requests.exceptions.ProxyError,
                requests.exceptions.ConnectionError,
                requests.exceptions.Timeout,
                requests.exceptions.SSLError,
            ) as e:
                print(f"  [✗] Прокси {proxy_str}: {type(e).__name__} ({attempt}/{max_retries})")
                self._next_proxy()   # бросит ProxyPoolExhausted если кончились
            except requests.exceptions.HTTPError:
                raise

        raise ProxyPoolExhausted(
            f"Не удалось выполнить запрос за {max_retries} попыток: {url}"
        )

    def current_proxy_info(self) -> str:
        if self._current:
            return f"{self._current['host']}:{self._current['port']} ({self._current['cc']}, {self._current['source']})"
        return "без прокси"


# ════════════════════════════════════════════════════════════
# Singleton — один пул на весь процесс
# ════════════════════════════════════════════════════════════

_proxy_session: ProxySession | None = None


def get_proxy_session() -> ProxySession:
    global _proxy_session
    if _proxy_session is None:
        _proxy_session = ProxySession()
    return _proxy_session
