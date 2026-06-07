# ════════════════════════════════════════════════════════════
# et.butb.by — НАСТРОЙКИ ПАРСЕРА
# Добавить в parser/config.py
# ════════════════════════════════════════════════════════════

# URL Cloudflare Worker для БУТБ (butb-worker)
BUTB_WORKER_URL = os.environ.get("BUTB_WORKER_URL", "").rstrip("/")

BUTB_BASE_URL = "https://et.butb.by"

# Максимум лотов при первичном слепке (сайт показывает ~290 активных)
BUTB_SNAPSHOT_LOTS_LIMIT = 400

# Те же паузы что и у других парсеров:
# DELAY_BETWEEN_LIST_PAGES, DELAY_BETWEEN_SECTIONS, DELAY_JITTER, DELAY_MINIMUM
# Те же параметры алгоритма: FULL_RESET_EVERY_DAYS, DAILY_LOTS_TTL_SECONDS
