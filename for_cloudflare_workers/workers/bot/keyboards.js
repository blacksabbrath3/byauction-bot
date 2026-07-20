/**
 * bot/keyboards.js — Все inline-клавиатуры и главное меню бота.
 */

import { REGIONS, DISTRICTS } from "../../shared/region.js";
import { SOURCES  } from "../../shared/sources.js";

export const MAX_KEYWORD_GROUPS = 15;

// ── Главное меню ──────────────────────────────────────────────

export function mainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "➕ Подписаться" }, { text: "📋 Мои подписки" }],
      [{ text: "❓ Помощь" }],
    ],
    resize_keyboard: true,
    persistent: true,
  };
}

// ── Подписка: источник ────────────────────────────────────────

export function inlineSourceChoice() {
  return { inline_keyboard: [
    [{ text: "🔀 Несколько сайтов сразу",                              callback_data: "sub_src:multi"    }],
    [{ text: "🏛 e-auction.by — торги",                                callback_data: "sub_src:eauction" }],
    [{ text: "🏙 Речицкий райисполком — аренда и покупка недвижимости", callback_data: "sub_src:rechitsa" }],
    [{ text: "🏦 torgi.gov.by — государственная торговая площадка",    callback_data: "sub_src:torgigov" }],
    [{ text: "🏗 БУТБ — имущество (et.butb.by)",                       callback_data: "sub_src:butb"     }],
    [{ text: "🏛 gostorg.by — электронные торги Госторга РБ",         callback_data: "sub_src:gostorg"  }],
    [{ text: "❌ Отмена", callback_data: "sub_cancel" }],
  ]};
}

export function inlineMultiSourcePick(selected) {
  const rows = SOURCES.map(s => {
    const checked = selected.includes(s.id) ? "✅ " : "◻️ ";
    return [{ text: `${checked}${s.label} — ${s.description}`, callback_data: `sub_msc:${s.id}` }];
  });
  rows.push([
    { text: "✔️ Готово", callback_data: "sub_msc:done" },
    { text: "❌ Отмена", callback_data: "sub_cancel"   },
  ]);
  return { inline_keyboard: rows };
}

// ── Подписка: тип лота (eauction) ────────────────────────────

export function inlineTypeChoice(selected = []) {
  const a = selected.includes("auction") ? "✅" : "◻️";
  const f = selected.includes("fixed")   ? "✅" : "◻️";
  return { inline_keyboard: [
    [{ text: `${a} 🔨 Аукцион`,            callback_data: "sub_t:auction" }],
    [{ text: `${f} 💰 Фиксированная цена`, callback_data: "sub_t:fixed"   }],
    [{ text: "✔️ Готово",                   callback_data: "sub_t:done"    }],
    [{ text: "❌ Отмена",                   callback_data: "sub_cancel"    }],
  ]};
}

// ── Подписка: регион ──────────────────────────────────────────

export function inlineRegion() {
  return { inline_keyboard: [
    [{ text: "🇧🇾 Вся страна",      callback_data: "sub_reg:all"    }],
    [{ text: "📍 Выбрать область",  callback_data: "sub_reg:oblast" }],
    [{ text: "🔤 Задать словами",   callback_data: "sub_reg:words"  }],
    [{ text: "❌ Отмена",           callback_data: "sub_cancel"     }],
  ]};
}

export function inlineOblasts() {
  const rows = [];
  for (let i = 0; i < REGIONS.length; i += 2) {
    const row = [{ text: REGIONS[i], callback_data: `sub_obl:${REGIONS[i]}` }];
    if (REGIONS[i + 1]) row.push({ text: REGIONS[i + 1], callback_data: `sub_obl:${REGIONS[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: "❌ Отмена", callback_data: "sub_cancel" }]);
  return { inline_keyboard: rows };
}

/** Список районов выбранной области с чекбоксами. */
export function inlineDistricts(oblast, selected = []) {
  const districts = DISTRICTS[oblast] || [];
  const rows = [];
  for (let i = 0; i < districts.length; i += 2) {
    const row = [];
    for (const d of districts.slice(i, i + 2)) {
      const checked = selected.includes(d) ? "✅ " : "";
      row.push({ text: `${checked}${d}`, callback_data: `sub_dst:${d}` });
    }
    rows.push(row);
  }
  rows.push([
    { text: "✔️ Готово",          callback_data: "sub_dst:done"  },
    { text: "☑️ Все районы",      callback_data: "sub_dst:all"   },
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "sub_cancel" }]);
  return { inline_keyboard: rows };
}

/** После выбора районов: завершить или уточнить до населённого пункта. */
export function inlineAfterDistrict() {
  return { inline_keyboard: [
    [{ text: "✅ Завершить выбор",            callback_data: "sub_council:skip"  }],
    [{ text: "📍 Ввести населённый пункт",    callback_data: "sub_council:enter" }],
    [{ text: "❌ Отмена",                     callback_data: "sub_cancel" }],
  ]};
}

// ── Подписка: ключевые слова ──────────────────────────────────

/**
 * Клавиатура выбора типа совпадения для каждого слова.
 * @param {Array}  flatTokens  - из buildFlatTokens()
 * @param {Object} wordTypes   - { key: "partial|exact|extended|custom" }
 * @param {number} groupIndex
 */
export function inlineWordTypeChoice(flatTokens, wordTypes, groupIndex) {
  const rows = [];

  rows.push([{ text: "ℹ️ О точности совпадений", callback_data: "noop" }]);

  let lastPhrase = null;

  flatTokens.forEach((token, idx) => {
    if (token.isPhrase && token.fullPhrase !== lastPhrase) {
      lastPhrase = token.fullPhrase;
      rows.push([{ text: `📝 Фраза: "${token.fullPhrase}"`, callback_data: "noop" }]);
    } else if (!token.isPhrase) {
      lastPhrase = null;
    }

    const currentType = wordTypes[token.key] || "partial";
    rows.push([{ text: `🔤 ${token.displayWord}`, callback_data: "noop" }]);
    rows.push([
      { text: `${currentType === "partial"  ? "✅" : "◻️"} Частичное`,    callback_data: `sub_wt|${groupIndex}|${idx}|partial`  },
      { text: `${currentType === "exact"    ? "✅" : "◻️"} Точное`,       callback_data: `sub_wt|${groupIndex}|${idx}|exact`    },
      { text: `${currentType === "extended" ? "✅" : "◻️"} Расширенное`,  callback_data: `sub_wt|${groupIndex}|${idx}|extended` },
    ]);
  });

  rows.push([{ text: "⚙️ Расширенный поиск (regex-подобный)", callback_data: `sub_custom|${groupIndex}` }]);
  rows.push([
    { text: "✅ Готово", callback_data: `sub_wt_done|${groupIndex}` },
    { text: "❌ Отмена", callback_data: "sub_cancel" },
  ]);
  return { inline_keyboard: rows };
}

export function inlineKeywordsSkip() {
  return { inline_keyboard: [
    [{ text: "⏭ Пропустить", callback_data: "sub_kw:skip" }],
    [{ text: "❌ Отмена",     callback_data: "sub_cancel"  }],
  ]};
}

export function inlineMaxPriceSkip() {
  return { inline_keyboard: [
    [{ text: "⏭ Без ограничения", callback_data: "sub_mp:skip" }],
    [{ text: "❌ Отмена",          callback_data: "sub_cancel"  }],
  ]};
}

export function inlineAddMoreGroups(currentCount) {
  const remaining = MAX_KEYWORD_GROUPS - currentCount;
  return { inline_keyboard: [
    [{ text: `➕ Добавить ещё группу (${remaining} осталось)`, callback_data: "sub_kg:add" }],
    [{ text: "✅ Завершить", callback_data: "sub_kg:done" }],
    [{ text: "❌ Отмена",    callback_data: "sub_cancel"  }],
  ]};
}

// ── Быстрые слова для ключевых запросов ────────────────────

// Популярные слова разбиты по тематическим группам.
// При нажатии кнопки слово добавляется через запятую к текущему вводу.
// ── Быстрые слова по категориям ──────────────────────────────

export const QUICK_WORD_CATEGORIES = [
  {
    id:    "realty",
    label: "🏠 Недвижимость",
    words: ["квартира", "дом", "дача", "склад", "гараж", "офис", "магазин",
            "земля", "участок", "здание", "помещение", "цех"],
  },
  {
    id:    "transport",
    label: "🚗 Транспорт",
    words: ["авто", "легковой", "грузовик", "автобус", "трактор",
            "прицеп", "мотоцикл", "спецтехника", "экскаватор", "кран"],
  },
  {
    id:    "equipment",
    label: "⚙️ Оборудование",
    words: ["оборудование", "станок", "пресс", "компрессор",
            "генератор", "насос", "котёл", "трансформатор"],
  },
  {
    id:    "furniture",
    label: "🪑 Мебель и быт",
    words: ["мебель", "стол", "шкаф", "холодильник", "телевизор",
            "стиральная", "кресло", "диван"],
  },
  {
    id:    "materials",
    label: "🧱 Материалы и сырьё",
    words: ["металл", "древесина", "лес", "пиломатериалы",
            "кирпич", "бетон", "кабель", "труба"],
  },
  {
    id:    "other",
    label: "📦 Прочее",
    words: ["инструмент", "запчасти", "животные", "продукты",
            "ткань", "одежда", "компьютер", "телефон"],
  },
];

// Плоский Set всех быстрых слов — для перехвата текстовых сообщений в dialog.js
export const ALL_QUICK_WORDS = new Set(
  QUICK_WORD_CATEGORIES.flatMap(c => c.words)
);

/**
 * reply_keyboard с быстрыми словами выбранной категории.
 * Нажатие отправляет слово как текст — dialog.js его перехватывает.
 */
export function replyKeywordsKeyboard(words) {
  const rows = [];
  for (let i = 0; i < words.length; i += 3) {
    rows.push(words.slice(i, i + 3).map(word => ({ text: word })));
  }
  return {
    keyboard:                rows,
    resize_keyboard:         true,
    one_time_keyboard:       false,
    input_field_placeholder: "Нажмите слово или напишите своё…",
    selective:               true,
  };
}

/** Убирает reply_keyboard. */
export function removeReplyKeyboard() {
  return { remove_keyboard: true, selective: true };
}

/** Инлайн-список категорий для выбора (первый экран). */
export function inlineCategoryPick(openCategoryId = null) {
  const rows = QUICK_WORD_CATEGORIES.map(cat => {
    const isOpen = cat.id === openCategoryId;
    return [{ text: isOpen ? `▾ ${cat.label}` : `▸ ${cat.label}`, callback_data: `sub_cat:${cat.id}` }];
  });
  return rows;
}

/** Инлайн-строки слов выбранной категории (показываются под заголовком категории). */
export function inlineCategoryWords(cat, selectedWords) {
  const rows = [];
  for (let i = 0; i < cat.words.length; i += 3) {
    rows.push(cat.words.slice(i, i + 3).map(word => ({
      text:          selectedWords.includes(word) ? `✅ ${word}` : word,
      callback_data: `sub_qw:${word}`,
    })));
  }
  return rows;
}

/**
 * Полная инлайн-клавиатура экрана быстрых слов.
 * openCategoryId: какая категория раскрыта (null = все свёрнуты).
 * selectedWords: уже выбранные слова (отмечаются ✅).
 */
export function inlineKeywordsControl(selectedWords = [], openCategoryId = null) {
  const rows = [];

  for (const cat of QUICK_WORD_CATEGORIES) {
    // Заголовок категории
    const isOpen = cat.id === openCategoryId;
    rows.push([{
      text:          isOpen ? `▾ ${cat.label}` : `▸ ${cat.label}`,
      callback_data: `sub_cat:${cat.id}`,
    }]);

    // Слова раскрытой категории
    if (isOpen) {
      for (let i = 0; i < cat.words.length; i += 3) {
        rows.push(cat.words.slice(i, i + 3).map(word => ({
          text:          selectedWords.includes(word) ? `✅ ${word}` : word,
          callback_data: `sub_qw:${word}`,
        })));
      }
    }
  }

  // Кнопки управления
  if (selectedWords.length > 0) {
    rows.push([
      { text: `✔️ Готово (${selectedWords.length} сл.)`, callback_data: "sub_kw:done_quick" },
      { text: "🗑 Очистить",                             callback_data: "sub_qw:clear"       },
    ]);
    rows.push([
      { text: "⌨️ Добавить вручную",  callback_data: "sub_kw:manual" },
    ]);
  } else {
    rows.push([
      { text: "⌨️ Ввести вручную", callback_data: "sub_kw:manual" },
    ]);
  }
  rows.push([
    { text: "⏭ Пропустить", callback_data: "sub_kw:skip"   },
    { text: "❌ Отмена",     callback_data: "sub_cancel"    },
  ]);

  return { inline_keyboard: rows };
}
