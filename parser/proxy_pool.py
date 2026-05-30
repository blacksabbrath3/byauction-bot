"""
proxy_pool.py — пул RU/BY прокси для обхода гео-блокировки torgi.gov.by

Все источники — GitHub Raw (доступны с GitHub Actions IP).
Приоритет источников задан в SOURCES_ORDERED и совпадает с порядком в config.
Страна определяется из самих данных — никаких внешних гео-API.

Источники (в порядке приоритета):
  1. roosterkid/HTTPS.txt   — флаги + явный CC в каждой строке
  2. roosterkid/SOCKS4.txt  — то же, SOCKS4; используем как HTTP-прокси
  3. roosterkid/SOCKS5.txt  — то же, SOCKS5
  4. proxifly all/data.json — 40k записей, поле geolocation.country
  5. proxifly RU/data.txt   — HTTP-прокси RU явно
  6. clarketm/proxy-list    — формат "IP:PORT CC-…"
  7. PROXY_EXTRA_SOURCES из config.py (пользовательские)
"""

import re
import json
import time
import random
import requests
import ipaddress

import config as cfg


# ── Исключение ─────────────────────────────────────────────

class ProxyPoolExhausted(Exception):
    """Все прокси из пула испробованы и ни один не сработал."""


# ── Константы ──────────────────────────────────────────────

FETCH_TIMEOUT  = 15    # сек — загрузка одного списка прокси
PROXY_TIMEOUT  = 25    # сек — один HTTP-запрос через прокси
ALLOWED_CC     = {"RU", "BY"}

# ── Паттерны ───────────────────────────────────────────────

# roosterkid: "🇷🇺 1.2.3.4:8080 400ms RU [ISP]"
_ROOSTERKID_RE = re.compile(
    r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})\s+\S+\s+(RU|BY)\b"
)
# clarketm: "1.2.3.4:8080 RU-A-S + "
_CLARKETM_RE = re.compile(
    r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})\s+(RU|BY)-"
)
# proxifly txt: "http://1.2.3.4:8080"
_URL_FORMAT_RE = re.compile(
    r"https?://(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})"
)


def _is_public_ip(ip: str) -> bool:
    try:
        obj = ipaddress.ip_address(ip)
        return not (obj.is_private or obj.is_loopback or obj.is_unspecified or obj.is_multicast)
    except ValueError:
        return False


# ════════════════════════════════════════════════════════════
# ЗАГРУЗКА ТЕКСТА
# ════════════════════════════════════════════════════════════

def _fetch(url: str) -> str | None:
    try:
        r = requests.get(
            url, timeout=FETCH_TIMEOUT,
            headers={"User-Agent": "Mozilla/5.0 proxy-fetcher/2.0"},
        )
        if r.status_code == 200:
            return r.text
        print(f"    [✗] {url} → HTTP {r.status_code}")
    except requests.RequestException as e:
        print(f"    [✗] {url} → {e}")
    return None


# ════════════════════════════════════════════════════════════
# ПАРСЕРЫ
# ════════════════════════════════════════════════════════════

def _parse_roosterkid(text: str, label: str) -> list[dict]:
    """Строки с явным CC: FLAG IP:PORT Xms CC [ISP]"""
    out = []
    for ip, port, cc in _ROOSTERKID_RE.findall(text):
        if _is_public_ip(ip):
            out.append({"host": ip, "port": int(port), "cc": cc, "src": label})
    return out


def _parse_clarketm(text: str) -> list[dict]:
    """Строки: IP:PORT CC-Anonymity-SSL +/-"""
    out = []
    for ip, port, cc in _CLARKETM_RE.findall(text):
        if _is_public_ip(ip):
            out.append({"host": ip, "port": int(port), "cc": cc, "src": "clarketm"})
    return out


def _parse_proxifly_json(text: str) -> list[dict]:
    """JSON-массив с полем geolocation.country и protocol."""
    out = []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return out
    for entry in data:
        if not isinstance(entry, dict):
            continue
        cc = entry.get("geolocation", {}).get("country", "")
        if cc not in ALLOWED_CC:
            continue
        proto = entry.get("protocol", "").lower()
        if proto not in ("http", "https"):
            continue
        ip   = entry.get("ip", "")
        port = entry.get("port", 0)
        if ip and port and _is_public_ip(ip):
            out.append({"host": ip, "port": int(port), "cc": cc, "src": "proxifly_json"})
    return out


def _parse_proxifly_txt(text: str, cc: str, label: str) -> list[dict]:
    """Строки вида http://IP:PORT (страна задана явно)."""
    out = []
    for ip, port in _URL_FORMAT_RE.findall(text):
        if _is_public_ip(ip):
            out.append({"host": ip, "port": int(port), "cc": cc, "src": label})
    return out


def _parse_ipport(text: str, cc: str, label: str) -> list[dict]:
    """Голые IP:PORT (страна задана явно)."""
    pat = re.compile(r"^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})$")
    out = []
    for line in text.splitlines():
        m = pat.match(line.strip())
        if m and _is_public_ip(m.group(1)):
            out.append({"host": m.group(1), "port": int(m.group(2)), "cc": cc, "src": label})
    return out


# ════════════════════════════════════════════════════════════
# ОПРЕДЕЛЕНИЕ ИСТОЧНИКОВ
# ════════════════════════════════════════════════════════════

def _builtin_sources() -> list[dict]:
    """
    Возвращает список встроенных источников.
    Каждый источник: {"url": str, "parse": callable(text)->list[dict]}
    Порядок = приоритет.
    """
    return [
        {
            "url":   "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS.txt",
            "parse": lambda t: _parse_roosterkid(t, "roosterkid_https"),
        },
        {
            "url":   "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4.txt",
            "parse": lambda t: _parse_roosterkid(t, "roosterkid_socks4"),
        },
        {
            "url":   "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5.txt",
            "parse": lambda t: _parse_roosterkid(t, "roosterkid_socks5"),
        },
        {
            "url":   "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.json",
            "parse": _parse_proxifly_json,
        },
        {
            "url":   "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/RU/data.txt",
            "parse": lambda t: _parse_proxifly_txt(t, "RU", "proxifly_RU"),
        },
        
    ]


def _extra_sources() -> list[dict]:
    """
    Дополнительные источники из config.PROXY_EXTRA_SOURCES.
    Формат строки: "тип|URL"

    Типы:
      roosterkid  — FLAG IP:PORT Xms CC [ISP]  (страна в строке)
      ipport_RU   — голые IP:PORT, все RU
      ipport_BY   — голые IP:PORT, все BY
      proxifly_json — JSON proxifly с geolocation.country
    """
    extra = []
    for entry in getattr(cfg, "PROXY_EXTRA_SOURCES", []):
        try:
            kind, url = entry.split("|", 1)
            kind, url = kind.strip().lower(), url.strip()
            if kind == "roosterkid":
                extra.append({"url": url, "parse": lambda t, u=url: _parse_roosterkid(t, u)})
            elif kind == "ipport_ru":
                extra.append({"url": url, "parse": lambda t, u=url: _parse_ipport(t, "RU", u)})
            elif kind == "ipport_by":
                extra.append({"url": url, "parse": lambda t, u=url: _parse_ipport(t, "BY", u)})
            elif kind == "proxifly_json":
                extra.append({"url": url, "parse": _parse_proxifly_json})
            else:
                print(f"  [!] PROXY_EXTRA_SOURCES: неизвестный тип '{kind}' в '{entry}'")
        except Exception as e:
            print(f"  [!] PROXY_EXTRA_SOURCES: неверный формат '{entry}': {e}")
    return extra


# ════════════════════════════════════════════════════════════
# ПОСТРОЕНИЕ ПУЛА
# ════════════════════════════════════════════════════════════

def build_pool() -> list[dict]:
    """
    Загружает все источники по порядку, дедуплицирует, перемешивает.
    Не бросает исключений — при отказе всех вернёт [].
    """
    print("[→] Собираю пул RU/BY прокси…")
    pool:  list[dict]  = []
    seen:  set[tuple]  = set()

    for src in _builtin_sources() + _extra_sources():
        url = src["url"]
        print(f"  → {url}")
        text = _fetch(url)
        if text is None:
            continue
        candidates = src["parse"](text)
        added = 0
        for p in candidates:
            key = (p["host"], p["port"])
            if key not in seen:
                seen.add(key)
                pool.append(p)
                added += 1
        print(f"    [✓] +{added} RU/BY прокси  (src={candidates[0]['src'] if candidates else '-'})")

    random.shuffle(pool)
    print(f"[✓] Итого в пуле: {len(pool)} уникальных RU/BY прокси")
    return pool


# ════════════════════════════════════════════════════════════
# ProxySession — requests.Session с авто-ротацией
# ════════════════════════════════════════════════════════════

def _proxy_url(p: dict) -> str:
    return f"http://{p['host']}:{p['port']}"


class ProxySession:
    """
    GET-сессия с автоматической ротацией прокси.
    При ошибке соединения переключается на следующий прокси.
    После MAX_PROXY_RETRIES неудач бросает ProxyPoolExhausted.
    """

    def __init__(self):
        self._pool:    list[dict]   = []
        self._idx:     int          = 0
        self._current: dict | None  = None
        self._session = requests.Session()
        self._session.headers.update(cfg.REQUEST_HEADERS)
        self._load_pool()

    def _load_pool(self) -> None:
        self._pool = build_pool()
        self._idx  = 0
        if self._pool:
            self._set_proxy(self._pool[0])
        else:
            print("[!] Пул пуст — прокси не используются (запрос может упасть)")

    def _set_proxy(self, p: dict) -> None:
        purl = _proxy_url(p)
        self._session.proxies = {"http": purl, "https": purl}
        self._current = p

    def _rotate(self) -> None:
        """Переключает на следующий прокси или бросает ProxyPoolExhausted."""
        self._idx += 1
        if self._idx >= len(self._pool):
            raise ProxyPoolExhausted(
                f"Исчерпаны все {len(self._pool)} прокси из пула"
            )
        self._set_proxy(self._pool[self._idx])

    def get(self, url: str, **kwargs) -> requests.Response:
        kwargs.setdefault("timeout", PROXY_TIMEOUT)
        max_retries = getattr(cfg, "MAX_PROXY_RETRIES", 15)

        for attempt in range(1, max_retries + 1):
            p_str = (f"{self._current['host']}:{self._current['port']}"
                     f" ({self._current['cc']}, {self._current['src']})"
                     if self._current else "без прокси")
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
                print(f"  [✗] {p_str}: {type(e).__name__} ({attempt}/{max_retries})")
                self._rotate()   # бросит ProxyPoolExhausted если кончились
            except requests.exceptions.HTTPError:
                raise

        raise ProxyPoolExhausted(
            f"Не удалось выполнить запрос за {max_retries} попыток: {url}"
        )

    def info(self) -> str:
        if self._current:
            p = self._current
            return f"{p['host']}:{p['port']} ({p['cc']}, {p['src']})"
        return "без прокси"


# ── Singleton ─────────────────────────────────────────────

_session: ProxySession | None = None


def get_proxy_session() -> ProxySession:
    global _session
    if _session is None:
        _session = ProxySession()
    return _session
