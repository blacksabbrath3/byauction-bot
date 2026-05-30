"""
torgigov_snapshot.py — полный слепок лотов torgi.gov.by

Алгоритм:
  1. Берём категории из torgigov_lib.TOP_CATEGORIES (хардкод, Angular SPA)
  2. POST /torgigov/save-categories → сохраняем список в KV для бота
  3. По каждой категории собираем первые SNAPSHOT_LOTS_LIMIT лотов
  4. POST /torgigov/snapshot → сохраняем known_lots в KV
"""

import os
import sys
import requests
from datetime import datetime, timezone

import config as cfg
import torgigov_lib as lib

WORKER_URL    = cfg.TORGIGOV_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET


def save_categories(categories: list[dict]) -> None:
    try:
        r = requests.post(
            f"{WORKER_URL}/save-categories",
            json={"categories": categories},
            headers={"X-API-Key": PARSER_SECRET},
            timeout=30,
        )
        r.raise_for_status()
        print(f"  [✓] /save-categories: {r.text[:120]}")
    except requests.RequestException as e:
        print(f"  [✗] /save-categories: {e}")


def snapshot_category(cat: dict) -> list[str]:
    """Собирает до SNAPSHOT_LOTS_LIMIT stored-URL лотов категории."""
    slug   = cat["slug"]
    cat_id = cat["category_id"]
    label  = cat["label"]
    print(f"\n  [+] Слепок: {label} (slug={slug}, id={cat_id})")

    all_paths: list[str] = []
    page = 1

    while len(all_paths) < cfg.SNAPSHOT_LOTS_LIMIT:
        url = lib.build_catalog_url(slug, cat_id, page)
        print(f"      → стр. {page}: {url}")
        soup = lib.get_soup(url)
        if soup is None:
            print("      [!] Пропуск страницы")
            break

        found = lib.extract_lot_urls(soup)
        print(f"         лотов: {len(found)}")
        if not found:
            break

        for p in found:
            if p not in all_paths:
                all_paths.append(p)
            if len(all_paths) >= cfg.SNAPSHOT_LOTS_LIMIT:
                break

        if lib.get_next_page_url(soup, url) is None:
            break

        page += 1
        lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)

    print(f"      Итого: {len(all_paths)} лотов")
    return all_paths


def main() -> None:
    print("=" * 60)
    print("  torgi.gov.by — полный слепок")
    print("=" * 60)

    # Шаг 1: категории из хардкода
    categories = lib.TOP_CATEGORIES
    print(f"\n[1] Категории ({len(categories)} шт. из хардкода):")
    for c in categories:
        print(f"    {c['label']:50s} → {c['slug']} (id={c['category_id']})")

    # Шаг 2: сохраняем категории в KV для бота
    print("\n[2] Сохраняю категории в KV…")
    save_categories(categories)

    # Шаг 3: слепок лотов по категориям
    print("\n[3] Собираю слепок лотов…")
    snapshot: dict[str, list[str]] = {}
    for cat in categories:
        paths = snapshot_category(cat)
        snapshot[cat["slug"]] = paths
        lib.pause(cfg.DELAY_BETWEEN_SECTIONS)

    # Шаг 4: сохраняем снапшот
    print("\n[4] Сохраняю снапшот…")
    try:
        r = requests.post(
            f"{WORKER_URL}/snapshot",
            json={"snapshot": snapshot},
            headers={"X-API-Key": PARSER_SECRET},
            timeout=60,
        )
        r.raise_for_status()
        print(f"  [✓] /snapshot: {r.text[:120]}")
    except requests.RequestException as e:
        print(f"  [✗] /snapshot: {e}")
        sys.exit(1)

    total = sum(len(v) for v in snapshot.values())
    print(f"\n  Итого лотов в снапшоте: {total}")
    print("=" * 60)
    print("  Готово.")
    print("=" * 60)


if __name__ == "__main__":
    main()
