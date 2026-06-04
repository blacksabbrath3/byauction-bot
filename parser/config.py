"""
config.py — все настройки парсеров e-auction.by и rechitsa.by
"""

import os

# ════════════════════════════════════════════════════════════
# ПОДКЛЮЧЕНИЕ К WORKER API
# Берётся из переменных окружения (GitHub Secrets).
# ════════════════════════════════════════════════════════════

# URL воркера e-auction (eauction-worker)
EAUCTION_WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")

# URL воркера rechitsa (rechitsa-worker)
RECHITSA_WORKER_URL = os.environ.get("RECHITSA_WORKER_URL", "").rstrip("/")

# Общий секрет для авторизации запросов к воркерам
PARSER_SECRET = os.environ.get("PARSER_SECRET", "")

# ════════════════════════════════════════════════════════════
# РАСПИСАНИЕ И РАНДОМНАЯ ЗАДЕРЖКА
# ════════════════════════════════════════════════════════════

# Workflow запускается в 02:00 UTC.
# Парсер сам спит случайное время до RANDOM_DELAY_MAX_SECONDS,
# чтобы реальный старт был равномерно распределён между 02:00 и 06:00 UTC.
# При ручном запуске (workflow_dispatch) задержка пропускается автоматически —
# переменная окружения SKIP_RANDOM_DELAY=true выставляется в yml.
RANDOM_DELAY_MAX_SECONDS = 144 # 4 часа

# Время отправки уведомлений подписчикам (UTC).
# "06:00" UTC = 09:00 Минск (UTC+3).
NOTIFY_TIME_UTC = "06:00"

# ════════════════════════════════════════════════════════════
# e-auction.by — РАЗДЕЛЫ САЙТА
# ════════════════════════════════════════════════════════════

SECTIONS = {
    "auction":  "/auction/",
    "commerce": "/commerce/",
    "gos":      "/gos/",
    "shop":     "/shop/",
    "showcase": "/showcase/",
}

SECTION_SORT_PARAM = {
    "auction":  "order=date-asc",
    "commerce": "order=date-asc",
    "gos":      "order=date-asc",
    "shop":     "order=date-asc",
    "showcase": "order=date-asc",
}

SECTION_NAMES = {
    "auction":  "⚖️ Арестованное имущество",
    "commerce": "🏠 Частное имущество",
    "gos":      "🏛️ Государственное имущество",
    "shop":     "🛒 Интернет-магазин",
    "showcase": "🪟 Интернет-витрина",
}

# ════════════════════════════════════════════════════════════
# e-auction.by — ПАУЗЫ МЕЖДУ ЗАПРОСАМИ
# ════════════════════════════════════════════════════════════

DELAY_BETWEEN_LIST_PAGES  = 8.0   # между страницами списка лотов (сек)
DELAY_BETWEEN_LOT_PAGES   = 10.0  # между страницами деталей лотов (сек)
DELAY_BETWEEN_SECTIONS    = 30.0  # между разделами (сек)
DELAY_JITTER              = 3.0   # случайный разброс ± (сек)
DELAY_MINIMUM             = 2.0   # абсолютный минимум любой паузы (сек)

# ════════════════════════════════════════════════════════════
# e-auction.by — HTTP
# ════════════════════════════════════════════════════════════

REQUEST_TIMEOUT    = 30
REQUEST_RETRIES    = 3
RETRY_BASE_DELAY   = 10.0

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# ════════════════════════════════════════════════════════════
# e-auction.by — СНАПШОТ И АЛГОРИТМ НОВЫХ ЛОТОВ
# ════════════════════════════════════════════════════════════

SNAPSHOT_LOTS_LIMIT    = 40   # максимум лотов на раздел при полном слепке
SEQ_WINDOW             = 10   # окно проверки последовательности
SEQ_MIN_MATCHES        = 3    # минимум совпадений в окне
FULL_RESET_EVERY_DAYS  = 30   # раз в N дней делать полный пересброс
DESCRIPTION_MAX_LEN    = 500
# Если снапшот был запущен менее N минут назад — daily пропускает парсинг
SNAPSHOT_GRACE_MINUTES = int(os.environ.get("SNAPSHOT_GRACE_MINUTES", "1"))
DAILY_LOTS_TTL_SECONDS = 99

EXCLUDE_PATH_PREFIXES = (
    "/info/", "/uslugi/", "/contacts/", "/personal/",
    "/upload/", "/local/", "/register", "/auth",
    "/register-of-failed", "/register-revaluation",
)

ROOTLEVEL_SECTIONS = {"auction", "commerce"}

# ════════════════════════════════════════════════════════════
# rechitsa.by — НАСТРОЙКИ ПАРСЕРА
# ════════════════════════════════════════════════════════════

RECHITSA_BASE_URL          = "https://rechitsa.by"
RECHITSA_GOSIM_URL         = "https://rechitsa.by/gosim"
RECHITSA_MAX_PAGES         = 5      # максимум страниц при поиске новых статей
RECHITSA_ARTICLE_TEXT_LIMIT = 500   # символов для excerpt уведомления
RECHITSA_DAILY_TTL_SECONDS = 99

# Паузы rechitsa
RECHITSA_DELAY_BETWEEN_ARTICLES = 10.0  # между загрузкой полных статей (сек)
RECHITSA_DELAY_BETWEEN_PAGES    = 5.0   # между страницами списка (сек)
RECHITSA_DELAY_MIN              = 2.0
RECHITSA_DELAY_MAX              = 5.0

# ════════════════════════════════════════════════════════════
# torgi.gov.by — НАСТРОЙКИ ПАРСЕРА
# ════════════════════════════════════════════════════════════

# URL воркера torgi.gov.by (torgigov-worker)
TORGIGOV_WORKER_URL = os.environ.get("TORGIGOV_WORKER_URL", "").rstrip("/")

# Те же HTTP-заголовки что и у e-auction используются через REQUEST_HEADERS
# Те же паузы DELAY_BETWEEN_LIST_PAGES / DELAY_BETWEEN_LOT_PAGES / DELAY_BETWEEN_SECTIONS
# Те же параметры алгоритма SEQ_WINDOW / SEQ_MIN_MATCHES / FULL_RESET_EVERY_DAYS
# Те же TTL DAILY_LOTS_TTL_SECONDS

# Максимум лотов на категорию при первичном слепке
TORGIGOV_SNAPSHOT_LOTS_LIMIT = 40

# ════════════════════════════════════════════════════════════
# torgi.gov.by — НАСТРОЙКИ ПАРСЕРА
# ════════════════════════════════════════════════════════════

# URL воркера torgigov
TORGIGOV_WORKER_URL = os.environ.get("TORGIGOV_WORKER_URL", "").rstrip("/")

TORGIGOV_BASE_URL = "https://torgi.gov.by"

# top-level category_id на torgi.gov.by (1–13, 164, 167)
# Перечислены для справки; реальный список хранится в KV и берётся оттуда.
TORGIGOV_TOP_LEVEL_CATEGORY_IDS = list(range(1, 14)) + [164, 167]

# ════════════════════════════════════════════════════════════
# ПРОКСИ — настройки для proxy_pool.py
# ════════════════════════════════════════════════════════════

# Максимум попыток смены прокси на один HTTP-запрос
MAX_PROXY_RETRIES = int(os.environ.get("MAX_PROXY_RETRIES", "15"))

# Дополнительные источники прокси (добавлять при необходимости).
# Формат каждой строки: "тип|URL"
# Типы:
#   roosterkid   — формат: FLAG IP:PORT Xms CC [ISP]  (страна читается из строки)
#   ipport_RU    — голые IP:PORT, все считаются российскими
#   ipport_BY    — голые IP:PORT, все считаются белорусскими
#   proxifly_json — JSON proxifly с полем geolocation.country
#
# Пример:
#   PROXY_EXTRA_SOURCES = [
#       "roosterkid|https://raw.githubusercontent.com/example/list/main/proxy.txt",
#       "ipport_RU|https://example.com/ru_proxies.txt",
#   ]
PROXY_EXTRA_SOURCES: list[str] = []

# ════════════════════════════════════════════════════════════
# ОПОВЕЩЕНИЯ ОБ ОШИБКАХ (прокси исчерпаны и т.п.)
# ════════════════════════════════════════════════════════════

# Email для алертов
ALERT_EMAIL = os.environ.get("ALERT_EMAIL", "blacksabbrath@gmail.com")

# Telegram chat_id для алертов (id администратора/группы)
# Установить через GitHub Secret ALERT_TELEGRAM_CHAT_ID
ALERT_TELEGRAM_CHAT_ID = os.environ.get("ALERT_TELEGRAM_CHAT_ID", "")

# Размер страницы при запросе API лотов
SNAPSHOT_PAGE_SIZE = int(os.environ.get("SNAPSHOT_PAGE_SIZE", "50"))
DAILY_PAGE_SIZE    = int(os.environ.get("DAILY_PAGE_SIZE",    "50"))
