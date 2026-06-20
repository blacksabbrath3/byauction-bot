"""
torgigov_snapshot.py — полный слепок лотов torgi.gov.by

Алгоритм: проходим по всем категориям из torgigov_lib.CATEGORIES
(133 шт., реальные ID с сайта), собираем ID лотов с первых нескольких
страниц каждой → POST /snapshot (плоский список).

API torgi.gov.by требует category как обязательный параметр — общий
список без категории недоступен, поэтому идём по дереву категорий.
"""

import sys
import requests

import config as cfg
import torgigov_lib as lib

WORKER_URL    = cfg.TORGIGOV_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET

# Сколько страниц на категорию максимум сканировать для снапшота
# (большие категории типа "Прочее" могут быть многостраничными,
# но для дедупликации достаточно последних N лотов)
SNAPSHOT_MAX_PAGES_PER_CATEGORY = getattr(cfg, "SNAPSHOT_MAX_PAGES_PER_CATEGORY", 3)


def _post(path: str, body: dict) -> dict:
    r = requests.post(
        f"{WORKER_URL}/{path}",
        json=body,
        headers={"X-API-Key": PARSER_SECRET, "Content-Type": "application/json"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def collect_snapshot_ids() -> list[str]:
    """
    Проходит по всем категориям, собирает lot_id с первых страниц каждой.
    """
    categories = lib.parse_top_categories()
    print(f"  Категорий: {len(categories)}")

    all_ids: list[str] = []
    seen: set[str] = set()

    for cat in categories:
        slug   = cat["slug"]
        cat_id = cat["category_id"]
        pagesize = cfg.DAILY_PAGE_SIZE

        for page in range(SNAPSHOT_MAX_PAGES_PER_CATEGORY):
            lots, total_pages = lib.fetch_lots_page(cat_id, slug, page=page, pagesize=pagesize)
            if not lots:
                break

            new_count = 0
            for l in lots:
                lid = l["lot_id"]
                if lid and lid not in seen:
                    seen.add(lid)
                    all_ids.append(lid)
                    new_count += 1

            if page + 1 >= total_pages:
                break
            lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)

        lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)

    return all_ids


def main() -> None:
    print("=" * 60)
    print("  torgi.gov.by — полный слепок")
    print("=" * 60)

    print("\n[1] Собираю слепок лотов по категориям…")
    ids = collect_snapshot_ids()

    print("\n[2] Сохраняю снапшот…")
    try:
        r = _post("snapshot", {"snapshot": ids})
        print(f"  [✓] /snapshot: {r}")
    except Exception as e:
        print(f"  [✗] /snapshot: {e}")
        sys.exit(1)

    print(f"\n  Итого лотов в снапшоте: {len(ids)}")
    print("=" * 60)
    print("  Готово.")
    print("=" * 60)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[✗] КРИТИЧЕСКАЯ ОШИБКА: {e}")
        sys.exit(1)
