"""
lot_utils.py — общие утилиты для всех парсеров.

Все парсеры (eauction, butb, torgigov, rechitsa) должны импортировать
функции отсюда, а не иметь собственные копии.
"""

import config as cfg


def find_new_lots(
    fetched_lots: list[dict],
    known_ids: set[str],
    id_field: str = "lot_id",
    stop_after_consecutive: int | None = None,
) -> tuple[list[dict], bool]:
    """
    Находит новые лоты из списка, сравнивая с известными ID.

    Алгоритм:
    - Проходит по fetched_lots (предполагается отсортированы от новых к старым)
    - Собирает все лоты с ID не из known_ids
    - Останавливается после stop_after_consecutive известных лотов ПОДРЯД
      (единичный известный лот посреди ленты НЕ прерывает сбор — он мог быть
      временно снят с торгов и переопубликован, или порядок сортировки
      немного нелинейный)

    Параметры:
        fetched_lots: список лотов с текущей страницы API
        known_ids: множество уже известных ID
        id_field: имя поля с ID в объекте лота (по умолчанию "lot_id")
        stop_after_consecutive: после скольких известных ПОДРЯД останавливаться.
            None — берётся из cfg.STOP_AFTER_CONSECUTIVE_KNOWN (default=3)

    Возвращает:
        (новые_лоты, дошли_до_серии_известных)
        Второй элемент True = можно не запрашивать следующую страницу,
        False = все лоты на странице новые, нужно идти дальше.
    """
    if stop_after_consecutive is None:
        stop_after_consecutive = getattr(cfg, "STOP_AFTER_CONSECUTIVE_KNOWN", 3)

    new_lots: list[dict] = []
    consecutive_known = 0

    for lot in fetched_lots:
        lid = str(lot.get(id_field) or "")
        if not lid:
            continue

        if lid in known_ids:
            consecutive_known += 1
            if consecutive_known >= stop_after_consecutive:
                return new_lots, True
        else:
            consecutive_known = 0
            new_lots.append(lot)

    return new_lots, False
