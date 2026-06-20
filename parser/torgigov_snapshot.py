"""
torgigov_snapshot.py — полный слепок лотов torgi.gov.by

Алгоритм (без категорий — общий список "Недавно добавленные"):
  1. По общему списку (без category) последовательно собираем lot_id
     со страниц, пока не наберём SNAPSHOT_TARGET_COUNT лотов
     (или не закончатся страницы) → POST /snapshot
"""

import sys
import requests

import config as cfg
import torgigov_lib as lib

WORKER_URL    = cfg.TORGIGOV_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET

# Сколько последних лотов достаточно сохранить в снапшоте для дедупликации
SNAPSHOT_TARGET_COUNT = getattr(cfg, "SNAPSHOT_TARGET_COUNT", 2000)


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
    Собирает lot_id с общего списка (без категорий), постранично,
    пока не наберёт SNAPSHOT_TARGET_COUNT или не закончатся страницы.
    """
    ids: list[str] = []
    page     = 0
    pagesize = cfg.DAILY_PAGE_SIZE

    while len(ids) < SNAPSHOT_TARGET_COUNT:
        print(f"  → стр. {page}")
        lots, total_pages = lib.fetch_lots_page(page=page, pagesize=pagesize)

        if not lots:
            print(f"  [i] Пустая страница — останавливаю")
            break

        ids.extend(l["lot_id"] for l in lots if l["lot_id"])
        print(f"     лотов на странице: {len(lots)}, всего собрано: {len(ids)}")

        if page + 1 >= total_pages:
            break
        page += 1
        lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)

    return ids[:SNAPSHOT_TARGET_COUNT]


def main() -> None:
    print("=" * 60)
    print("  torgi.gov.by — полный слепок")
    print("=" * 60)

    print("\n[1] Собираю слепок лотов (без категорий)…")
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
