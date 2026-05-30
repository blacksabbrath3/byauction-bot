"""
eauction_snapshot.py — слепок последних лотов e-auction.by

Сохраняет {path: rank} где rank — позиция лота в сортировке по дате
(0 = самый новый на момент слепка).

Запускается:
  • вручную через initial_snapshot workflow
  • автоматически из daily.py раз в FULL_RESET_EVERY_DAYS дней
"""

import os
import sys
import requests

import config as cfg
import lib

WORKER_URL    = cfg.EAUCTION_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET


def parse_section_all(section_key: str, section_path: str) -> list[str]:
    """
    Обходит ВСЕ страницы раздела.
    Возвращает список путей в порядке сортировки по дате (индекс 0 = самый новый).
    Ранги НЕ присваиваются здесь — это делает Python при загрузке из KV.
    """
    print(f"\n[+] Раздел: {section_key}")
    ordered: list[str] = []
    seen: set[str] = set()
    page = 1

    while True:
        url = lib.build_section_url(section_path, section_key, page)
        print(f"  → страница {page}: {url}")

        soup = lib.get_soup(url)
        if soup is None:
            print("  [!] Пропуск страницы")
            break

        found = lib.extract_lot_paths(soup, section_key)
        for p in found:
            if p not in seen:
                seen.add(p)
                ordered.append(p)
        print(f"     лотов на странице: {len(found)}, всего: {len(ordered)}")

        if not found:
            break
        if len(ordered) >= cfg.SNAPSHOT_LOTS_LIMIT:
            print(f"  [✓] Достигнут лимит {cfg.SNAPSHOT_LOTS_LIMIT} лотов")
            break
        if not lib.get_next_page_url(soup, url):
            break

        page += 1
        lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)

    print(f"  Итого: {len(ordered)} лотов")
    lib.pause(cfg.DELAY_BETWEEN_SECTIONS)
    return ordered


def send_snapshot(snapshot: dict[str, list[str]]) -> None:
    """
    POST /snapshot
    Body: { snapshot: { section: [path, ...], ... } }
    """
    endpoint = f"{WORKER_URL}/snapshot"
    print(f"\n[→] Отправляю слепок на {endpoint} …")
    try:
        r = requests.post(
            endpoint,
            json={"snapshot": snapshot},
            headers={"X-API-Key": PARSER_SECRET},
            timeout=30,
        )
        r.raise_for_status()
        print(f"[✓] {r.status_code}: {r.text[:200]}")
    except requests.RequestException as e:
        print(f"[✗] Ошибка: {e}")
        sys.exit(1)


def send_categories(categories: list[dict]) -> None:
    """
    POST /save-categories
    Body: { categories: [{slug, label}, ...] }
    Сохраняет список категорий аукциона в KV для использования ботом.
    """
    if not categories:
        print("[!] Категории пусты, пропускаю отправку")
        return
    endpoint = f"{WORKER_URL}/save-categories"
    print(f"\n[→] Отправляю категории на {endpoint} …")
    try:
        r = requests.post(
            endpoint,
            json={"categories": categories},
            headers={"X-API-Key": PARSER_SECRET},
            timeout=30,
        )
        r.raise_for_status()
        print(f"[✓] {r.status_code}: {r.text[:200]}")
    except requests.RequestException as e:
        print(f"[✗] Ошибка отправки категорий: {e}")


def main() -> None:
    print("=" * 60)
    print("  e-auction.by — полный слепок (snapshot)")
    print("=" * 60)

    # Парсим категории аукциона (единый каталог для auction/commerce/gos)
    print("\n[0] Парсю категории аукциона…")
    categories = lib.parse_auction_categories()
    lib.pause(cfg.DELAY_BETWEEN_SECTIONS)

    snapshot: dict[str, list[str]] = {}
    for key, path in cfg.SECTIONS.items():
        snapshot[key] = parse_section_all(key, path)

    total = sum(len(v) for v in snapshot.values())
    print(f"\n[=] Итого лотов: {total}")
    for k, v in snapshot.items():
        print(f"    {k:12s}: {len(v)}")

    send_snapshot(snapshot)
    send_categories(categories)
    print("\n[✓] Слепок и категории сохранены.")


if __name__ == "__main__":
    main()
