"""
eauction_daily.py — ежедневный парсер новых лотов e-auction.by

Алгоритм:
  1. Получает known_lots из KV: {section: {path: rank}}
  2. По каждому разделу парсит страницы (сортировка по дате, новые первыми)
     → определяет новые лоты через find_new_lots()
  3. Новые пути → мерж в known_lots (POST /add-lots)
  4. Для новых путей парсит детали → суточная пачка (POST /save-daily-lots)
  5. ПОСЛЕ всего: если прошло ≥ FULL_RESET_EVERY_DAYS — запускает snapshot.main()
"""

import os
import sys
import time
from datetime import date, datetime, timezone

import requests

import config as cfg
import lib
import eauction_snapshot as snapshot_module

WORKER_URL    = cfg.EAUCTION_WORKER_URL
PARSER_SECRET = cfg.PARSER_SECRET


# ════════════════════════════════════════════════════════════
# ПРОВЕРКА НЕОБХОДИМОСТИ ПОЛНОГО СБРОСА
# ════════════════════════════════════════════════════════════

def _parse_status_ts(ts: str) -> datetime | None:
    """Парсит timestamp из /status — поддерживает locale и ISO форматы."""
    if not ts:
        return None
    for fmt in ("%d.%m.%Y, %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(ts, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def was_snapshot_just_run() -> bool:
    """
    Возвращает True если снапшот был запущен менее SNAPSHOT_GRACE_MINUTES минут назад.
    В этом случае daily пропускает парсинг — нечего искать.
    """
    grace = getattr(cfg, "SNAPSHOT_GRACE_MINUTES", 120)
    try:
        r = lib.SESSION.get(
            f"{WORKER_URL}/status",
            headers={"X-API-Key": PARSER_SECRET},
            timeout=20,
        )
        r.raise_for_status()
        snap_ts = r.json().get("snapshot_ts")
        snap_dt = _parse_status_ts(snap_ts)
        if snap_dt is None:
            return False
        minutes_ago = (datetime.now(timezone.utc) - snap_dt).total_seconds() / 60
        print(f"[i] Снапшот был {minutes_ago:.0f} мин назад (grace={grace} мин)")
        if minutes_ago < grace:
            print(f"[i] → Пропускаю парсинг (снапшот свежий).")
            return True
        return False
    except Exception as e:
        print(f"[!] was_snapshot_just_run: {e}")
        return False


def should_do_full_reset() -> bool:
    try:
        r = lib.SESSION.get(
            f"{WORKER_URL}/status",
            headers={"X-API-Key": PARSER_SECRET},
            timeout=20,
        )
        r.raise_for_status()
        last_reset = r.json().get("last_full_reset")
        last_dt = _parse_status_ts(last_reset)
        if last_dt is None:
            return False
        days = (datetime.now(timezone.utc) - last_dt).days
        print(f"[i] Последний сброс: {last_reset} ({days} дн. назад)")
        return days >= cfg.FULL_RESET_EVERY_DAYS
    except Exception as e:
        print(f"[!] Не удалось проверить /status: {e}")
        return False


# ════════════════════════════════════════════════════════════
# ПОЛУЧЕНИЕ KNOWN_LOTS
# ════════════════════════════════════════════════════════════

def fetch_known_lots() -> dict[str, dict[str, int]]:
    """
    GET /known-lots → {section: {path: rank}}

    Worker хранит и возвращает массив путей ["/path1/", "/path2/", ...].
    Порядок массива = порядок сортировки по дате на момент последнего слепка.
    Здесь присваиваем ранги по индексу: rank=0 — самый новый.

    Формат базы не трогаем — конвертация только в памяти Python.
    """
    try:
        r = lib.SESSION.get(
            f"{WORKER_URL}/known-lots",
            headers={"X-API-Key": PARSER_SECRET},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        result = {}
        for section, value in data.items():
            if isinstance(value, list):
                # Основной формат: массив путей в порядке даты публикации
                # rank = индекс в массиве (0 = самый новый)
                result[section] = {path: rank for rank, path in enumerate(value)}
            elif isinstance(value, dict):
                # На случай если Worker вернул уже dict (будущая совместимость)
                result[section] = {k: int(v) for k, v in value.items()}
            else:
                result[section] = {}
        return result
    except Exception as e:
        print(f"[!] Не удалось получить known_lots: {e} — работаем с пустой базой")
        return {k: {} for k in cfg.SECTIONS}


# ════════════════════════════════════════════════════════════
# ПАРСИНГ РАЗДЕЛА
# ════════════════════════════════════════════════════════════

def parse_section_daily(
    section_key: str,
    section_path: str,
    snapshot: dict[str, int],
) -> list[str]:
    """
    Парсит раздел постранично (сортировка по дате, новые первыми).
    Накапливает пути и при каждой новой порции вызывает find_new_lots.
    Останавливается когда find_new_lots сигнализирует о конце новых.

    Возвращает список новых путей.
    """
    print(f"\n[+] Раздел: {section_key}")
    all_daily: list[str] = []   # накопленный список из дневного парсинга
    page = 1
    stopped = False

    while not stopped:
        url = lib.build_section_url(section_path, section_key, page)
        print(f"  → страница {page}: {url}")

        soup = lib.get_soup(url)
        if soup is None:
            print("  [!] Пропуск страницы")
            break

        found = lib.extract_lot_paths(soup, section_key)
        print(f"     лотов на странице: {len(found)}")

        if not found:
            break

        prev_len = len(all_daily)
        for p in found:
            if p not in all_daily:   # дедупликация с сохранением порядка
                all_daily.append(p)

        # Проверяем: find_new_lots обрабатывает весь накопленный список.
        # Если длина результата меньше длины all_daily — алгоритм остановился
        # внутри текущей страницы → дальше парсить не нужно.
        new_paths = lib.find_new_lots(all_daily, snapshot)

        added_this_page = len(all_daily) - prev_len
        if added_this_page > 0 and len(new_paths) < len(all_daily):
            # Алгоритм нашёл точку останова на этой странице
            stopped = True
        elif not lib.get_next_page_url(soup, url):
            break
        else:
            page += 1
            lib.pause(cfg.DELAY_BETWEEN_LIST_PAGES)

    # Финальный результат
    new_paths = lib.find_new_lots(all_daily, snapshot)
    print(f"  Новых лотов: {len(new_paths)} из {len(all_daily)} проверенных")
    lib.pause(cfg.DELAY_BETWEEN_SECTIONS)
    return new_paths


# ════════════════════════════════════════════════════════════
# СОХРАНЕНИЕ НОВЫХ ПУТЕЙ В KNOWN_LOTS
# ════════════════════════════════════════════════════════════

def add_to_known_lots(section: str, new_paths: list[str], current_snapshot: dict[str, int]) -> None:
    """
    POST /add-lots — вставляет новые пути В НАЧАЛО массива known_lots в KV.

    Worker хранит массив [path, ...] в порядке новизны (index 0 = самый новый).
    Новые лоты вставляются в начало — при следующем чтении Python присвоит им
    наименьшие ранги (0, 1, 2...) и они окажутся «левее» всех лотов слепка.

    new_paths передаём в порядке новизны: index 0 = самый новый из новых.
    """
    if not new_paths:
        return

    try:
        r = requests.post(
            f"{WORKER_URL}/add-lots",
            json={"section": section, "paths": new_paths},
            headers={"X-API-Key": PARSER_SECRET},
            timeout=30,
        )
        r.raise_for_status()
        print(f"  [✓] /add-lots: {r.text[:120]}")
    except requests.RequestException as e:
        print(f"  [✗] /add-lots: {e}")


# ════════════════════════════════════════════════════════════
# ПАРСИНГ ДЕТАЛЕЙ И СУТОЧНАЯ ПАЧКА
# ════════════════════════════════════════════════════════════

def fetch_details_and_save(section: str, new_paths: list[str]) -> None:
    if not new_paths:
        return

    print(f"\n  Парсю детали {len(new_paths)} лотов раздела «{section}»…")
    lots = []
    for i, path in enumerate(new_paths, 1):
        print(f"    [{i}/{len(new_paths)}] {path}")
        lot = lib.parse_lot_details(path, section)
        lot["section"] = section
        lots.append(lot)
        lib.pause(cfg.DELAY_BETWEEN_LOT_PAGES)

    today = date.today().isoformat()
    try:
        r = requests.post(
            f"{WORKER_URL}/save-daily-lots",
            json={
                "date":    today,
                "section": section,
                "lots":    lots,
                "ttl":     cfg.DAILY_LOTS_TTL_SECONDS,
            },
            headers={"X-API-Key": PARSER_SECRET},
            timeout=30,
        )
        r.raise_for_status()
        print(f"  [✓] /save-daily-lots: {r.text[:120]}")
    except requests.RequestException as e:
        print(f"  [✗] /save-daily-lots: {e}")


# ════════════════════════════════════════════════════════════
# ОЖИДАНИЕ ВРЕМЕНИ ОТПРАВКИ И РАССЫЛКА УВЕДОМЛЕНИЙ
# ════════════════════════════════════════════════════════════

def wait_until_notify_time() -> None:
    """
    Блокирует выполнение до наступления cfg.NOTIFY_TIME_UTC (формат "HH:MM").
    Если время уже прошло — не ждёт (рассылает сразу).
    GitHub Actions job не имеет жёсткого лимита для таких пауз (лимит 6 часов).
    """
    hour, minute = map(int, cfg.NOTIFY_TIME_UTC.split(":"))
    now = datetime.now(timezone.utc)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    wait_sec = (target - now).total_seconds()
    if wait_sec > 0:
        print(f"\n[→] Жду до {cfg.NOTIFY_TIME_UTC} UTC ({int(wait_sec // 60)} мин) перед отправкой уведомлений…")
        time.sleep(wait_sec)
    else:
        print(f"\n[→] Время отправки {cfg.NOTIFY_TIME_UTC} UTC уже наступило, рассылаю сразу.")


def send_notifications(section_keys: list[str]) -> None:
    """
    POST /send-notifications для каждого раздела в котором были новые лоты.
    """
    today = date.today().isoformat()
    for section in section_keys:
        print(f"  [→] /send-notifications: {section} за {today}")
        try:
            r = requests.post(
                f"{WORKER_URL}/send-notifications",
                json={"date": today, "section": section},
                headers={"X-API-Key": PARSER_SECRET},
                timeout=60,
            )
            r.raise_for_status()
            print(f"  [✓] {r.text[:120]}")
        except requests.RequestException as e:
            print(f"  [✗] /send-notifications [{section}]: {e}")


# ════════════════════════════════════════════════════════════
# ТОЧКА ВХОДА
# ════════════════════════════════════════════════════════════

def random_delay() -> None:
    """
    Случайная задержка перед стартом парсинга.
    Пропускается если SKIP_RANDOM_DELAY=true (ручной запуск workflow_dispatch).
    """
    import random
    if os.environ.get("SKIP_RANDOM_DELAY", "").lower() == "true":
        print("[i] Рандомная задержка пропущена (ручной запуск).")
        return
    max_sec = cfg.RANDOM_DELAY_MAX_SECONDS
    delay = random.randint(0, max_sec)
    print(f"[i] Рандомная задержка: {delay} сек ({delay // 60} мин). Старт в ~{delay // 3600 + 2}:xx UTC")
    time.sleep(delay)


def main() -> None:
    print("=" * 60)
    print("  e-auction.by — дневной парсинг")
    print("=" * 60)

    # Шаг 0: Рандомная задержка (пропускается при ручном запуске)
    random_delay()

    # Шаг 0.5: Если снапшот был запущен недавно — нечего парсить
    if was_snapshot_just_run():
        print("\n[i] Снапшот только что завершён — парсинг пропущен.")
        print("    (Чтобы принудительно запустить, подожди SNAPSHOT_GRACE_MINUTES минут)")
        print("=" * 60)
        return

    # Шаг 1: Загружаем known_lots
    print("\n[1] Загружаю known_lots…")
    known_all = fetch_known_lots()
    for k, v in known_all.items():
        print(f"    {k:12s}: {len(v)} известных")

    total_new = 0
    sections_with_new: list[str] = []  # разделы где были новые лоты — для рассылки

    # Шаги 2–4: По каждому разделу
    for section_key, section_path in cfg.SECTIONS.items():
        print(f"\n{'─' * 60}")
        snap = known_all.get(section_key, {})

        new_paths = parse_section_daily(section_key, section_path, snap)

        if not new_paths:
            print(f"  Новых лотов нет.")
            continue

        total_new += len(new_paths)
        sections_with_new.append(section_key)
        add_to_known_lots(section_key, new_paths, snap)
        fetch_details_and_save(section_key, new_paths)

    print(f"\n{'─' * 60}")
    print(f"  Итого новых лотов: {total_new}")

    # Шаг 5: Полный сброс если нужен (ПОСЛЕ дневного парсинга)
    print("\n[5] Проверяю необходимость полного сброса…")
    if should_do_full_reset():
        print("[→] Запускаю полный слепок (активен со следующего дня)…")
        snapshot_module.main()
    else:
        print("[i] Полный сброс не нужен.")

    # Шаг 6: Ждём времени отправки и рассылаем уведомления
    if sections_with_new:
        print(f"\n[6] Разделы с новыми лотами: {', '.join(sections_with_new)}")
        wait_until_notify_time()
        print("\n[6] Отправляю уведомления подписчикам…")
        send_notifications(sections_with_new)
    else:
        print("\n[6] Новых лотов нет — уведомления не отправляются.")

    print(f"\n{'=' * 60}")
    print("  Готово.")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
