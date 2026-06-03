"""
torgigov_snapshot.py — полный слепок лотов torgi.gov.by

Алгоритм:
  1. Парсим категории с главной страницы → POST /save-categories
  2. По каждой категории запрашиваем все страницы через API
     GET {WORKER}/api-lots?category={id}&page={n}&pagesize=50
  3. Собираем lot_id → POST /snapshot
"""

import os
import sys
import requests
from datetime import datetime, timezone

import config as cfg
import torgigov_lib as lib

WORKER_URL    = cfg.TORGIGOV_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET


def _post(path: str, body: dict) -> dict:
    r = requests.post(
        f"{WORKER_URL}/{path}",
        json=body,
        headers={"X-API-Key": PARSER_SECRET, "Content-Type": "application/json"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def save_categories(categories: list[dict]) -> None:
    try:
        r = _post("save-categories", {"categories": categories})
        print(f"  [✓] /save-categories: {r}")
    except Exception as e:
        print(f"  [✗] /save-categories: {e}")


def snapshot_category(cat: dict) -> list[str]:
    """Забирает 10 последних лотов категории — достаточно для дневного сравнения."""
    slug   = cat["slug"]
    cat_id = cat["category_id"]
    label  = cat["label"]
    print(f"\n  [+] Слепок: {label} (id={cat_id})")

    lots, _ = lib.fetch_lots_page(cat_id, slug, page=0, pagesize=10)

    ids = [l["lot_id"] for l in lots if l["lot_id"]]
    print(f"      Лотов: {len(ids)}")
    return ids


def main() -> None:
    print("=" * 60)
    print("  torgi.gov.by — полный слепок")
    print("=" * 60)

    print("\n[1] Парсю категории…")
    categories = lib.parse_top_categories()
    if not categories:
        print("[!] Категории не получены — прерываю")
        sys.exit(1)

    print("\n[2] Сохраняю категории в KV…")
    save_categories(categories)

    print("\n[3] Собираю слепок лотов…")
    snapshot: dict[str, list[str]] = {}
    for cat in categories:
        ids = snapshot_category(cat)
        snapshot[cat["slug"]] = ids
        lib.pause(cfg.DELAY_BETWEEN_SECTIONS)

    print("\n[4] Сохраняю снапшот…")
    try:
        r = _post("snapshot", {"snapshot": snapshot})
        print(f"  [✓] /snapshot: {r}")
    except Exception as e:
        print(f"  [✗] /snapshot: {e}")
        sys.exit(1)

    total = sum(len(v) for v in snapshot.values())
    print(f"\n  Итого лотов в снапшоте: {total}")
    print("=" * 60)
    print("  Готово.")
    print("=" * 60)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[✗] КРИТИЧЕСКАЯ ОШИБКА: {e}")
        sys.exit(1)
      
