"""
butb_snapshot.py — полный слепок лотов et.butb.by

Алгоритм:
  1. GET /et/auctions.xhtml — первая страница (все лоты)
  2. Определяем общее число страниц из пагинатора
  3. Собираем lot_id со всех страниц (не более SNAPSHOT_LOTS_LIMIT на рубрику)
  4. POST /snapshot → {slug: [lot_id, ...]}
  5. POST /save-categories → [{slug, label}, ...]

Рубрики не требуют отдельных запросов для снапшота:
все лоты доступны через "all" (без фильтра).
При необходимости можно делать отдельные запросы по рубрикам
через ICEFaces — но для снапшота достаточно "all".
"""

import sys
import time
import requests
from datetime import datetime, timezone

import config as cfg
import butb_lib as lib

WORKER_URL    = cfg.BUTB_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET


# ════════════════════════════════════════════════════════════
# WORKER API
# ════════════════════════════════════════════════════════════

def _post(path: str, body: dict) -> dict:
    r = requests.post(
        f"{WORKER_URL}/{path}",
        json=body,
        headers={"X-API-Key": PARSER_SECRET, "Content-Type": "application/json"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


# ════════════════════════════════════════════════════════════
# СБОР СНАПШОТА
# ════════════════════════════════════════════════════════════

def collect_snapshot() -> dict[str, list[str]]:
    """
    Собирает lot_id со всех страниц листинга.
    Возвращает {"all": [lot_id, ...]}.
    Лимит: cfg.SNAPSHOT_LOTS_LIMIT лотов.
    """
    limit  = cfg.SNAPSHOT_LOTS_LIMIT
    slug   = "all"
    all_ids: list[str] = []

    print(f"\n[→] Загружаю страницу 1…")
    soup = lib.fetch_listing_page(page=1)
    if not soup:
        print("[!] Не удалось загрузить первую страницу")
        return {}

    # Состояние формы для последующих запросов
    base_state  = lib.extract_form_state(soup)
    total_pages = lib.get_total_pages(soup)
    print(f"[i] Всего страниц: {total_pages}")

    ids = lib.parse_lot_ids_from_soup(soup)
    all_ids.extend(ids)
    print(f"    стр. 1: {len(ids)} лотов")

    # Обходим оставшиеся страницы
    for page in range(2, total_pages + 1):
        if len(all_ids) >= limit:
            print(f"[i] Достигнут лимит {limit} лотов — останавливаюсь")
            break

        lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)
        print(f"\n[→] Загружаю страницу {page}/{total_pages}…")
        soup = lib.fetch_listing_page(page=page, base_state=base_state)
        if not soup:
            print(f"  [!] Страница {page} не загружена — пропускаю")
            continue

        ids = lib.parse_lot_ids_from_soup(soup)
        if not ids:
            print(f"  [i] Страница {page} пуста — останавливаюсь")
            break

        all_ids.extend(ids)
        print(f"    стр. {page}: {len(ids)} лотов (итого: {len(all_ids)})")

    # Обрезаем до лимита
    all_ids = all_ids[:limit]
    print(f"\n[✓] Собрано: {len(all_ids)} lot_id")
    return {slug: all_ids}


# ════════════════════════════════════════════════════════════
# СОХРАНЕНИЕ
# ════════════════════════════════════════════════════════════

def save_snapshot(snapshot: dict[str, list[str]]) -> None:
    total = sum(len(v) for v in snapshot.values())
    print(f"\n[→] POST /snapshot ({total} лотов)…")
    try:
        r = _post("snapshot", {"snapshot": snapshot})
        print(f"[✓] /snapshot: {r}")
    except Exception as e:
        print(f"[✗] /snapshot: {e}")
        raise


def save_categories() -> None:
    categories = [
        {"slug": slug, "label": label}
        for slug, label in lib.RUBRIC_LABELS.items()
    ]
    print(f"\n[→] POST /save-categories ({len(categories)} рубрик)…")
    try:
        r = _post("save-categories", {"categories": categories})
        print(f"[✓] /save-categories: {r}")
    except Exception as e:
        print(f"[!] /save-categories: {e}")


# ════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════

def main() -> None:
    print("=" * 60)
    print("  et.butb.by — полный снапшот")
    print("=" * 60)

    snapshot = collect_snapshot()
    if not snapshot:
        raise RuntimeError("Снапшот пуст — возможно, сайт недоступен")

    save_snapshot(snapshot)

    print(f"\n{'=' * 60}")
    print("  Снапшот завершён.")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[✗] ОШИБКА: {e}")
        sys.exit(1)
