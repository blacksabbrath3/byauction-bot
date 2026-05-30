// ============================================================
// workers/bot/index.js — Telegram-бот
// Только логика бота: команды, диалоги подписок, список подписок.
// Парсерные данные и рассылку делают отдельные воркеры.
//
// Bindings (Cloudflare Worker Settings):
//   KV:      SUBSCRIBERS → bot_subscribers
//   Secrets: BOT_TOKEN, PARSER_SECRET, EAUCTION_WORKER_URL, WEBHOOK_SECRET (опционально)
//
// ВАЖНО: webhook зарегистрировать с параметром:
//   allowed_updates: ["message","callback_query","my_chat_member"]
// ============================================================

import { escapeHtml, jsonResponse }          from "../../shared/format.js";
import { tgCall, sendMessage, editMessage, answerCallback } from "../../shared/telegram.js";

const MAX_SUBS   = 10;
const DIALOG_TTL = 1800; // 30 мин
const MAX_KEYWORD_GROUPS = 15;

const REGIONS = [
  "Брестская", "Витебская", "Гомельская",
  "Гродненская", "Минская", "Могилёвская",
];

const FALLBACK_CATEGORIES = [
  { slug: "legkovye_avtomobili",                           label: "Легковые автомобили" },
  { slug: "gruzovaya_tekhnika_i_avtobusy",                 label: "Грузовая техника и автобусы" },
  { slug: "mototekhnika_i_sredstva_personalnoy_mobilnosti", label: "Мототехника" },
  { slug: "nedvizhimost",                                  label: "Недвижимость" },
  { slug: "spetstekhnika",                                 label: "Спецтехника" },
  { slug: "stanki_i_oborudovanie",                         label: "Станки и оборудование" },
  { slug: "dolya_v_ustavnom_fonde",                        label: "Доля в уставном фонде" },
  { slug: "predpriyatie_kak_imushchestvennyy_kompleks",    label: "Предприятие как имущ. комплекс" },
  { slug: "drugoe_imushchestvo",                           label: "Другое имущество" },
];

// ── Helpers ───────────────────────────────────────────────────

function shortUUID() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function regionLabel(r) {
  if (r === "all") return "🌍 Вся страна";
  if (r === "keywords") return "🔤 По ключевым словам";
  if (Array.isArray(r)) return r.join(", ");
  return r;
}

function categoryLabels(categories, slugs) {
  if (!slugs || slugs.length === 0) return "✅ Все категории";
  return slugs.map(slug => {
    const c = categories.find(x => x.slug === slug);
    return c ? c.label : slug;
  }).join(", ");
}

function torgigovCategoryLabels(categories, slugs) {
  if (!slugs || slugs.length === 0) return "✅ Все категории";
  return slugs.map(slug => {
    const c = categories.find(x => x.slug === slug);
    return c ? c.label : slug;
  }).join(", ");
}

function wordMatchTypeLabel(type) {
  switch (type) {
    case "partial": return "частичное";
    case "exact": return "точное";
    case "extended": return "расширенное";
    case "custom": return "свое";
    default: return "частичное";
  }
}

function subSummary(sub, categories) {
  if (sub.source === "rechitsa") {
    const lines = ["🏙 <b>Речицкий райисполком</b> — приобретение и аренда"];
    lines.push(sub.keywords?.length > 0
      ? `<b>Ключевые слова:</b> ${formatKeywordGroups(sub.keywords)}`
      : "<b>Ключевые слова:</b> все уведомления");
    return lines.join("\n");
  }
  if (sub.source === "torgigov") {
    const lines = ["🏦 <b>torgi.gov.by</b> — государственная торговая площадка"];
    lines.push(`<b>Категории:</b> ${torgigovCategoryLabels(categories, sub.categories)}`);
    lines.push(`<b>Регион:</b> ${regionLabel(sub.region)}`);
    if (sub.keywords?.length > 0) {
      lines.push(`<b>Ключевые слова:</b> ${formatKeywordGroups(sub.keywords)}`);
    }
    if (sub.max_price > 0) {
      lines.push(`<b>Макс. цена:</b> ${sub.max_price.toLocaleString("ru-RU")} BYN`);
    }
    return lines.join("\n");
  }
  const typeLabel = sub.type === "auction" ? "🔨 Аукцион" : "💰 Фиксированная цена";
  const lines = [`🏛 <b>e-auction.by</b> — ${typeLabel}`];
  if (sub.type === "auction") {
    lines.push(`<b>Категории:</b> ${categoryLabels(categories, sub.categories)}`);
  }
  lines.push(`<b>Регион:</b> ${regionLabel(sub.region)}`);
  if (sub.keywords?.length > 0) {
    lines.push(`<b>Ключевые слова:</b> ${formatKeywordGroups(sub.keywords)}`);
  }
  if (sub.max_price > 0) {
    lines.push(`<b>Макс. цена:</b> ${sub.max_price.toLocaleString("ru-RU")} BYN`);
  }
  return lines.join("\n");
}

function formatKeywordGroups(groups) {
  return groups.map(group => {
    return group.map(w => {
      let label = w.word;
      if (w.type && w.type !== "partial") {
        label += ` (${wordMatchTypeLabel(w.type)}`;
        if (w.pattern) label += `: ${w.pattern}`;
        label += `)`;
      }
      return label;
    }).join(" + ");
  }).join(", ");
}

// ── Парсинг ключевых слов ────────────────────────────────────

/**
 * Разбивает ввод пользователя на токены для группы.
 * "Гомел, улица Советская, авто" → 
 * [
 *   { word: "Гомел", isPhrase: false, phraseWords: ["Гомел"] },
 *   { word: "улица Советская", isPhrase: true, phraseWords: ["улица", "Советская"] },
 *   { word: "авто", isPhrase: false, phraseWords: ["авто"] }
 * ]
 */
function parseGroupInput(input) {
  const parts = input.split(",").map(p => p.trim()).filter(Boolean);
  
  return parts.map(part => {
    const hasSpace = part.includes(" ");
    const phraseWords = hasSpace ? part.split(/\s+/).filter(Boolean) : [part];
    return {
      word: part,
      isPhrase: hasSpace,
      phraseWords: phraseWords,
    };
  });
}

/**
 * Строит плоский список токенов для клавиатуры.
 * Каждый токен имеет: displayWord (для показа), phraseIndex (индекс фразы в парседе),
 * wordIndex (индекс слова внутри фразы).
 */
function buildFlatTokens(parsedParts) {
  const flat = [];
  parsedParts.forEach((part, phraseIdx) => {
    part.phraseWords.forEach((word, wordIdx) => {
      flat.push({
        displayWord: word,
        fullPhrase: part.word,
        isPhrase: part.isPhrase,
        phraseIdx: phraseIdx,
        wordIdx: wordIdx,
        // Уникальный ключ для хранения типа
        key: part.isPhrase ? `${part.word}|${word}` : word,
      });
    });
  });
  return flat;
}

// ── KV helpers ────────────────────────────────────────────────

async function getSubs(env, userId) {
  const raw = await env.SUBSCRIBERS.get(`sub:${userId}`);
  return raw ? JSON.parse(raw) : [];
}
async function saveSubs(env, userId, subs) {
  await env.SUBSCRIBERS.put(`sub:${userId}`, JSON.stringify(subs));
}
async function getDialog(env, userId) {
  const raw = await env.SUBSCRIBERS.get(`dialog:${userId}`);
  return raw ? JSON.parse(raw) : null;
}
async function saveDialog(env, userId, data) {
  await env.SUBSCRIBERS.put(`dialog:${userId}`, JSON.stringify(data), { expirationTtl: DIALOG_TTL });
}
async function deleteDialog(env, userId) {
  await env.SUBSCRIBERS.delete(`dialog:${userId}`);
}
async function getCategories(env) {
  try {
    const r = await fetch(`${env.EAUCTION_WORKER_URL}/categories`, {
      headers: { "X-API-Key": env.PARSER_SECRET },
    });
    if (r.ok) return r.json();
  } catch (e) {
    console.warn("getCategories fetch failed:", e.message);
  }
  return FALLBACK_CATEGORIES;
}

async function getTorgigovCategories(env) {
  try {
    const r = await fetch(`${env.TORGIGOV_WORKER_URL}/categories`, {
      headers: { "X-API-Key": env.PARSER_SECRET },
    });
    if (r.ok) return r.json();
  } catch (e) {
    console.warn("getTorgigovCategories fetch failed:", e.message);
  }
  return [];
}

function inlineTorgigovCategories(categories, selected) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(categories.slice(i, i + 2).map(cat => ({
      text: `${selected.includes(cat.slug) ? "✅" : "◻️"} ${cat.label}`,
      callback_data: `sub_tgc:${cat.slug}`,
    })));
  }
  rows.push([
    { text: "☑️ Все категории", callback_data: "sub_tgc:all"  },
    { text: "✔️ Готово",        callback_data: "sub_tgc:done" },
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "sub_cancel" }]);
  return { inline_keyboard: rows };
}

async function setMyCommands(token) {
  await tgCall(token, "setMyCommands", {
    commands: [
      { command: "subscribe",       description: "➕ Создать подписку" },
      { command: "list",            description: "📋 Мои подписки" },
      { command: "unsubscribe_all", description: "🗑 Удалить все подписки" },
      { command: "help",            description: "❓ Справка" },
    ],
  });
  await tgCall(token, "setChatMenuButton", { menu_button: { type: "commands" } });
}

function mainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "➕ Подписаться" }, { text: "📋 Мои подписки" }],
      [{ text: "🗑 Удалить все подписки" }, { text: "❓ Справка" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// ── Keyboard builders ─────────────────────────────────────────

function inlineSourceChoice() {
  return { inline_keyboard: [
    [{ text: "🏛 e-auction.by — торги",                            callback_data: "sub_src:eauction" }],
    [{ text: "🏙 Речицкий райисполком — аренда и покупка недвижимости", callback_data: "sub_src:rechitsa" }],
    [{ text: "🏦 torgi.gov.by — государственная торговая площадка",  callback_data: "sub_src:torgigov" }],
    [{ text: "❌ Отмена", callback_data: "sub_cancel" }],
  ]};
}

function inlineTypeChoice() {
  return { inline_keyboard: [
    [
      { text: "🔨 Аукцион",            callback_data: "sub_t:auction" },
      { text: "💰 Фиксированная цена", callback_data: "sub_t:fixed"   },
    ],
    [{ text: "❌ Отмена", callback_data: "sub_cancel" }],
  ]};
}

function inlineCategories(categories, selected) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(categories.slice(i, i + 2).map(cat => ({
      text: `${selected.includes(cat.slug) ? "✅" : "◻️"} ${cat.label}`,
      callback_data: `sub_c:${cat.slug}`,
    })));
  }
  rows.push([
    { text: "☑️ Все категории", callback_data: "sub_c:all"  },
    { text: "✔️ Готово",        callback_data: "sub_c:done" },
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "sub_cancel" }]);
  return { inline_keyboard: rows };
}

function inlineRegion() {
  return { inline_keyboard: [
    [{ text: "🇧🇾 Вся страна",      callback_data: "sub_reg:all"      }],
    [{ text: "📍 Выбрать область",  callback_data: "sub_reg:oblast"   }],
    [{ text: "🔤 Задать словами",   callback_data: "sub_reg:words"    }],
    [{ text: "❌ Отмена",           callback_data: "sub_cancel"       }],
  ]};
}

function inlineOblasts() {
  const rows = [];
  for (let i = 0; i < REGIONS.length; i += 2) {
    const row = [{ text: REGIONS[i], callback_data: `sub_obl:${REGIONS[i]}` }];
    if (REGIONS[i + 1]) row.push({ text: REGIONS[i + 1], callback_data: `sub_obl:${REGIONS[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: "❌ Отмена", callback_data: "sub_cancel" }]);
  return { inline_keyboard: rows };
}

// ── Клавиатуры для выбора типов слов ─────────────────────────

/**
 * Клавиатура для выбора типа совпадения.
 * @param {Array} flatTokens - плоский список токенов
 * @param {Object} wordTypes - { key: "partial|exact|extended|custom" }
 * @param {number} groupIndex - индекс текущей группы
 */
function inlineWordTypeChoice(flatTokens, wordTypes, groupIndex) {
  const rows = [];
  let lastPhrase = null;
  
  flatTokens.forEach((token, idx) => {
    // Если началась новая фраза, добавляем заголовок
    if (token.isPhrase && token.fullPhrase !== lastPhrase) {
      lastPhrase = token.fullPhrase;
      rows.push([{ 
        text: `📝 Фраза: "${token.fullPhrase}"`, 
        callback_data: "noop" 
      }]);
    } else if (!token.isPhrase) {
      lastPhrase = null;
    }
    
    const currentType = wordTypes[token.key] || "partial";
    
    // Слово
    rows.push([{ 
      text: `🔤 ${token.displayWord}`, 
      callback_data: "noop" 
    }]);
    
    // Кнопки выбора типа
    rows.push([
      { 
        text: `${currentType === "partial" ? "✅" : "◻️"} Частичное`, 
        callback_data: `sub_wt|${groupIndex}|${idx}|partial` 
      },
      { 
        text: `${currentType === "exact" ? "✅" : "◻️"} Точное`, 
        callback_data: `sub_wt|${groupIndex}|${idx}|exact` 
      },
      { 
        text: `${currentType === "extended" ? "✅" : "◻️"} Расширенное`, 
        callback_data: `sub_wt|${groupIndex}|${idx}|extended` 
      },
    ]);
  });
  
  rows.push([{ 
    text: "⚙️ Расширенный поиск", 
    callback_data: `sub_custom|${groupIndex}` 
  }]);
  rows.push([
    { text: "✅ Готово", callback_data: `sub_wt_done|${groupIndex}` },
    { text: "❌ Отмена", callback_data: "sub_cancel" },
  ]);
  
  return { inline_keyboard: rows };
}

function inlineKeywordsSkip() {
  return { inline_keyboard: [
    [{ text: "⏭ Пропустить", callback_data: "sub_kw:skip" }],
    [{ text: "❌ Отмена",     callback_data: "sub_cancel"  }],
  ]};
}

function inlineMaxPriceSkip() {
  return { inline_keyboard: [
    [{ text: "⏭ Без ограничения", callback_data: "sub_mp:skip" }],
    [{ text: "❌ Отмена",          callback_data: "sub_cancel"  }],
  ]};
}

function inlineAddMoreGroups(currentCount) {
  const remaining = MAX_KEYWORD_GROUPS - currentCount;
  return { inline_keyboard: [
    [{ text: `➕ Добавить ещё группу (${remaining} осталось)`, callback_data: "sub_kg:add" }],
    [{ text: "✅ Завершить", callback_data: "sub_kg:done" }],
    [{ text: "❌ Отмена", callback_data: "sub_cancel" }],
  ]};
}

// ── Тексты шагов ─────────────────────────────────────────────

function categoryStepText(selected, categories) {
  const selLine = selected.length > 0
    ? `\n\nВыбрано: ${selected.map(s => (categories.find(x => x.slug === s) || {}).label || s).join(", ")}`
    : "";
  return `📋 <b>Новая подписка — e-auction.by</b>\n\nВыберите категории (можно несколько):${selLine}\n\nНажмите «✔️ Готово» или «☑️ Все категории».`;
}

function maxPricePromptText() {
  return (
    `📋 <b>Новая подписка — e-auction.by</b>\n\n` +
    `Укажите максимальную цену в BYN (необязательно).\n\n` +
    `Лоты дороже этой суммы приходить <b>не будут</b>.\n` +
    `Лоты <b>без цены</b> приходят всегда.\n\n` +
    `Введите число, например: <code>5000</code>\n\n` +
    `Или нажмите «Без ограничения».`
  );
}

function keywordsPromptText(source) {
  const prefix = source === "rechitsa"
    ? "📋 <b>Новая подписка — Речицкий райисполком</b>\n\n"
    : source === "torgigov"
      ? "📋 <b>Новая подписка — torgi.gov.by</b>\n\n"
      : "📋 <b>Новая подписка — e-auction.by</b>\n\n";
  return (
    `${prefix}<b>Ключевые слова</b> (необязательно):\n\n` +
    `Введите слова или фразы через <b>запятую</b>. Все слова из группы должны встретиться в тексте лота (в любом месте, но обязательно все).\n\n` +
    `Для поиска целой фразы — разделяйте слова фразы <b>пробелом</b>.\n\n` +
    `<b>Пример:</b> <code>Гомел, улица Советская, авто</code>\n` +
    `<i>Бот найдёт лоты, где есть "Гомел", фраза "улица Советская" и "авто".</i>\n\n` +
    `После ввода вы сможете выбрать тип совпадения для каждого слова.\n\n` +
    `Или нажмите «Пропустить» — будут приходить все новые публикации.`
  );
}

function wordTypesHelpText() {
  return (
    `<b>Типы совпадений:</b>\n\n` +
    `🔍 <b>Частичное</b> — слово найдётся как часть текста.\n` +
    `<i>Пример: Гомел → Гомель, Гомельский, Гомельской</i>\n\n` +
    `🎯 <b>Точное</b> — строгое совпадение целого слова.\n` +
    `<i>Пример: Гомель → только Гомель, но не Гомельский</i>\n` +
    `<i>Для фразы: каждый компонент ищется как отдельное слово</i>\n\n` +
    `🔤 <b>Расширенное</b> — частичное + до 3 любых символов в конце.\n` +
    `<i>Пример: Гомел → Гомель, Гомеле, Гомеля, но не Гомельский</i>\n` +
    `<i>Пример: Советск → Советская, Советский, Советских</i>`
  );
}

function customPatternHelpText() {
  return (
    `<b>Расширенный поиск</b>\n\n` +
    `Введите слово с символами:\n` +
    `<code>?</code> — ровно 1 любой символ\n` +
    `<code>*</code> — любое количество любых символов\n\n` +
    `<b>Примеры:</b>\n` +
    `<code>Гомел??</code> — Гомель, Гомеле (не Гомельский)\n` +
    `<code>*оветск*</code> — Советский, советских, райсоветский\n\n` +
    `Введите шаблон для группы:`
  );
}

function currentGroupsSummary(groups) {
  if (!groups || groups.length === 0) return "";
  let text = `\n\n📝 <b>Текущие группы (${groups.length}/${MAX_KEYWORD_GROUPS}):</b>\n`;
  groups.forEach((group, i) => {
    text += `${i + 1}. `;
    text += group.map(w => {
      let label = w.word;
      if (w.type && w.type !== "partial") {
        label += ` (${wordMatchTypeLabel(w.type)}`;
        if (w.pattern) label += `: ${w.pattern}`;
        label += `)`;
      }
      return label;
    }).join(" + ");
    text += "\n";
  });
  return text;
}

function groupSummaryText(group) {
  return group.map(w => {
    let label = `<b>${w.word}</b>`;
    if (w.type && w.type !== "partial") {
      label += ` (${wordMatchTypeLabel(w.type)}`;
      if (w.pattern) label += `: ${w.pattern}`;
      label += `)`;
    }
    return label;
  }).join(" +\n");
}

// ── Диалог подписки ───────────────────────────────────────────

async function startSubscribeDialog(token, chatId, userId, env) {
  const subs = await getSubs(env, userId);
  if (subs.length >= MAX_SUBS) {
    return sendMessage(token, chatId,
      `⚠️ Достигнут лимит подписок (${MAX_SUBS}). Удалите лишние командой /list.`);
  }
  await saveDialog(env, userId, { step: "source", data: {} });
  return sendMessage(token, chatId,
    `📋 <b>Новая подписка</b>\n\nНа какой источник хотите подписаться?`,
    { reply_markup: inlineSourceChoice() });
}

async function handleCallback(token, update, env) {
  const cb     = update.callback_query;
  const userId = String(cb.from.id);
  const chatId = cb.message.chat.id;
  const msgId  = cb.message.message_id;
  const data   = cb.data;

  await answerCallback(token, cb.id);

  // Отмена
  if (data === "sub_cancel") {
    await deleteDialog(env, userId);
    return editMessage(token, chatId, msgId, "❌ Создание подписки отменено.");
  }

  // Удаление подписки из списка
  if (data.startsWith("del:")) {
    const subs = await getSubs(env, userId);
    const idx  = subs.findIndex(s => s.id === data.slice(4));
    if (idx === -1) return editMessage(token, chatId, msgId, "⚠️ Подписка не найдена.");
    subs.splice(idx, 1);
    await saveSubs(env, userId, subs);
    const categories = await getCategories(env);
    return sendListMessage(token, chatId, userId, env, categories, msgId);
  }

  // Noop кнопка (заголовок)
  if (data === "noop") {
    return;
  }

  const dialog = await getDialog(env, userId);
  if (!dialog) {
    return sendMessage(token, chatId, "⚠️ Сессия истекла. Начните заново: /subscribe");
  }

  // Шаг 0: выбор источника
  if (data.startsWith("sub_src:") && dialog.step === "source") {
    const source = data.slice(8);
    dialog.data.source = source;

    if (source === "rechitsa") {
      dialog.step = "keywords_input";
      dialog.data.keywordGroups = [];
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        keywordsPromptText("rechitsa") + currentGroupsSummary(dialog.data.keywordGroups),
        { reply_markup: inlineKeywordsSkip() });
    } else if (source === "torgigov") {
      const tgCats = await getTorgigovCategories(env);
      dialog.data.torgigovCategories = tgCats;
      dialog.data.selectedTorgigovCategories = [];
      dialog.step = "torgigov_categories";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — torgi.gov.by</b>\n\nШаг 1 из 3 — Выберите категории (можно несколько):`,
        { reply_markup: inlineTorgigovCategories(tgCats, []) });
    } else {
      dialog.step = "type";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — e-auction.by</b>\n\nШаг 1 из 3 — Что отслеживать?`,
        { reply_markup: inlineTypeChoice() });
    }
  }

  // ── torgigov: выбор категорий ────────────────────────────────
  if (data.startsWith("sub_tgc:") && dialog.step === "torgigov_categories") {
    const slug = data.slice(8);
    const tgCats = dialog.data.torgigovCategories || [];
    let selected = dialog.data.selectedTorgigovCategories || [];

    if (slug === "all") {
      selected = [];
    } else if (slug === "done") {
      dialog.data.categories = selected;
      dialog.step = "region";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — torgi.gov.by</b>\n\nШаг 2 из 3 — Регион:`,
        { reply_markup: inlineRegion() });
    } else {
      if (selected.includes(slug)) {
        selected = selected.filter(s => s !== slug);
      } else {
        selected = [...selected, slug];
      }
    }

    dialog.data.selectedTorgigovCategories = selected;
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📋 <b>Новая подписка — torgi.gov.by</b>\n\nШаг 1 из 3 — Выберите категории (можно несколько):`,
      { reply_markup: inlineTorgigovCategories(tgCats, selected) });
  }

  // Шаг 1: тип e-auction
  if (data.startsWith("sub_t:") && dialog.step === "type") {
    const type = data.slice(6);
    dialog.data.type = type;

    if (type === "auction") {
      const categories = await getCategories(env);
      dialog.data.selectedCategories = [];
      dialog.step = "categories";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        categoryStepText([], categories),
        { reply_markup: inlineCategories(categories, []) });
    } else {
      dialog.data.categories = [];
      dialog.step = "region";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — e-auction.by</b>\n\nШаг 2 из 3 — Выберите регион:`,
        { reply_markup: inlineRegion() });
    }
  }

  // Шаг 2: категории
  if (data.startsWith("sub_c:") && dialog.step === "categories") {
    const categories = await getCategories(env);
    const slug = data.slice(6);

    if (slug === "all") {
      dialog.data.selectedCategories = [];
      dialog.data.allCategories = true;
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        categoryStepText([], categories) + "\n\n☑️ <b>Выбраны все категории.</b> Нажмите «✔️ Готово».",
        { reply_markup: inlineCategories(categories, []) });
    }

    if (slug === "done") {
      const sel = dialog.data.selectedCategories || [];
      if (!dialog.data.allCategories && sel.length === 0) {
        await answerCallback(token, cb.id, "Выберите хотя бы одну категорию или нажмите «☑️ Все категории»");
        return;
      }
      dialog.data.categories = dialog.data.allCategories ? [] : sel;
      delete dialog.data.selectedCategories;
      delete dialog.data.allCategories;
      dialog.step = "region";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — e-auction.by</b>\n\nШаг 2 из 3 — Выберите регион:`,
        { reply_markup: inlineRegion() });
    }

    const sel = dialog.data.selectedCategories || [];
    const idx = sel.indexOf(slug);
    if (idx === -1) sel.push(slug); else sel.splice(idx, 1);
    dialog.data.selectedCategories = sel;
    dialog.data.allCategories = false;
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      categoryStepText(sel, categories),
      { reply_markup: inlineCategories(categories, sel) });
  }

  // Регион
  if (data === "sub_reg:all") {
    dialog.data.region = "all";
    dialog.step = "keywords_input";
    dialog.data.keywordGroups = [];
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      keywordsPromptText("eauction") + currentGroupsSummary(dialog.data.keywordGroups),
      { reply_markup: inlineKeywordsSkip() });
  }
  if (data === "sub_reg:oblast") {
    dialog.step = "region_oblast";
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📋 <b>Новая подписка — e-auction.by</b>\n\nВыберите область:`,
      { reply_markup: inlineOblasts() });
  }
  if (data.startsWith("sub_obl:") && dialog.step === "region_oblast") {
    dialog.data.region = [data.slice(8)];
    dialog.step = "keywords_input";
    dialog.data.keywordGroups = [];
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      keywordsPromptText("eauction") + currentGroupsSummary(dialog.data.keywordGroups),
      { reply_markup: inlineKeywordsSkip() });
  }

  if (data === "sub_reg:words") {
    dialog.data.region = "keywords";
    dialog.step = "keywords_input";
    dialog.data.keywordGroups = [];
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      keywordsPromptText("eauction") + currentGroupsSummary(dialog.data.keywordGroups),
      { reply_markup: inlineKeywordsSkip() });
  }

  // Ключевые слова: пропустить
  if (data === "sub_kw:skip") {
    dialog.data.keywords = [];
    if (dialog.data.source === "rechitsa") {
      dialog.data.max_price = 0;
      const categories = await getCategories(env);
      return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
    }
    if (dialog.data.source === "torgigov") {
      dialog.data.max_price = 0;
      const categories = await getTorgigovCategories(env);
      return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
    }
    dialog.step = "max_price";
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      maxPricePromptText(), { reply_markup: inlineMaxPriceSkip() });
  }

  // Максимальная цена: пропустить
  if (data === "sub_mp:skip") {
    dialog.data.max_price = 0;
    const categories = await getCategories(env);
    return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
  }

  // Обработка выбора типа слова
  if (data.startsWith("sub_wt|")) {
    const parts = data.split("|");
    const groupIdx = parseInt(parts[1]);
    const tokenIdx = parseInt(parts[2]);
    const type = parts[3];
    
    if (!dialog.data.keywordGroups || !dialog.data.keywordGroups[groupIdx]) {
      await answerCallback(token, cb.id, "Ошибка: группа не найдена");
      return;
    }
    
    if (!dialog.data.currentFlatTokens || !dialog.data.currentFlatTokens[tokenIdx]) {
      await answerCallback(token, cb.id, "Ошибка: токен не найден");
      return;
    }
    
    const flatToken = dialog.data.currentFlatTokens[tokenIdx];
    const group = dialog.data.keywordGroups[groupIdx];

    // Ищем элемент в группе по уникальному ключу токена
    const groupItem = group.find(w => w.key === flatToken.key);

    if (!groupItem) {
      await answerCallback(token, cb.id, "Ошибка: слово не найдено в группе");
      return;
    }

    groupItem.type = type;
    if (type !== "custom") {
      delete groupItem.pattern;
    }

    await saveDialog(env, userId, dialog);

    // Обновляем wordTypes по ключу токена
    const wordTypes = {};
    group.forEach(w => {
      wordTypes[w.key] = w.type || "partial";
    });
    
    return editMessage(token, chatId, msgId,
      wordTypesHelpText() + "\n\n" + groupSummaryText(group),
      { reply_markup: inlineWordTypeChoice(
        dialog.data.currentFlatTokens,
        wordTypes,
        groupIdx
      )});
  }

  // Готово с типами слов
  if (data.startsWith("sub_wt_done|")) {
    const gIdx = parseInt(data.split("|")[1]);
    
    if (!dialog.data.keywordGroups || !dialog.data.keywordGroups[gIdx]) {
      await answerCallback(token, cb.id, "Ошибка: группа не найдена");
      return;
    }
    
    const group = dialog.data.keywordGroups[gIdx];
    for (const w of group) {
      if (!w.type) w.type = "partial";
    }
    
    // Очищаем временные данные
    delete dialog.data.currentFlatTokens;
    delete dialog.data.currentParsedParts;
    
    await saveDialog(env, userId, dialog);
    
    return editMessage(token, chatId, msgId,
      `📝 <b>Группа ${gIdx + 1} сохранена</b>\n\n` +
      groupSummaryText(group) +
      currentGroupsSummary(dialog.data.keywordGroups),
      { reply_markup: inlineAddMoreGroups(dialog.data.keywordGroups.length) });
  }

  // Добавить ещё группу
  if (data === "sub_kg:add") {
    if (dialog.data.keywordGroups.length >= MAX_KEYWORD_GROUPS) {
      await answerCallback(token, cb.id, `Максимум ${MAX_KEYWORD_GROUPS} групп`);
      return;
    }
    dialog.step = "keywords_input";
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📝 Введите слова для группы ${dialog.data.keywordGroups.length + 1}:\n\n` +
      `<b>Пример:</b> <code>Минск, Советская, авто</code>\n\n` +
      `Слова разделяются запятой — все должны встретиться в тексте (в любом месте, но обязательно все).` +
      currentGroupsSummary(dialog.data.keywordGroups),
      { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "sub_cancel" }]] } });
  }

  // Завершить ввод групп
  if (data === "sub_kg:done") {
    dialog.data.keywords = dialog.data.keywordGroups || [];
    if (dialog.data.source === "rechitsa") {
      dialog.data.max_price = 0;
      const categories = await getCategories(env);
      return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
    }
    if (dialog.data.source === "torgigov") {
      dialog.data.max_price = 0;
      const categories = await getTorgigovCategories(env);
      return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
    }
    dialog.step = "max_price";
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      maxPricePromptText(), { reply_markup: inlineMaxPriceSkip() });
  }

  // Расширенный поиск
  if (data.startsWith("sub_custom|")) {
    const gIdx = parseInt(data.split("|")[1]);
    dialog.step = "custom_pattern";
    dialog.data.customGroupIndex = gIdx;
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      customPatternHelpText(),
      { reply_markup: { inline_keyboard: [
        [{ text: "🔙 Назад", callback_data: `sub_back_to_types|${gIdx}` }],
        [{ text: "❌ Отмена", callback_data: "sub_cancel" }],
      ]}});
  }

  // Назад к выбору типов
  if (data.startsWith("sub_back_to_types|")) {
    const gIdx = parseInt(data.split("|")[1]);
    dialog.step = "keywords_select_types";
    
    if (!dialog.data.keywordGroups || !dialog.data.keywordGroups[gIdx]) {
      await answerCallback(token, cb.id, "Ошибка: группа не найдена");
      return;
    }
    
    const group = dialog.data.keywordGroups[gIdx];
    
    // Перестраиваем flatTokens из новой структуры группы (каждое слово — отдельный элемент с key)
    dialog.data.currentFlatTokens = group.map(w => ({
      key:         w.key,
      displayWord: w.word,
      fullPhrase:  w.phraseGroup || w.word,
      isPhrase:    w.isPhrase || false,
      phraseIdx:   0,
      wordIdx:     0,
    }));

    const wordTypes = {};
    group.forEach(w => {
      wordTypes[w.key] = w.type || "partial";
    });
    
    await saveDialog(env, userId, dialog);
    
    return editMessage(token, chatId, msgId,
      wordTypesHelpText() + "\n\n" + groupSummaryText(group),
      { reply_markup: inlineWordTypeChoice(
        dialog.data.currentFlatTokens,
        wordTypes,
        gIdx
      )});
  }
}

async function handleTextInDialog(token, chatId, userId, text, env) {
  const dialog = await getDialog(env, userId);
  if (!dialog) return null;

  // Обработка ввода custom pattern
  if (dialog.step === "custom_pattern") {
    const gIdx = dialog.data.customGroupIndex;
    if (!dialog.data.keywordGroups || !dialog.data.keywordGroups[gIdx]) {
      return sendMessage(token, chatId, "⚠️ Ошибка: группа не найдена.");
    }
    
    const group = dialog.data.keywordGroups[gIdx];
    group.forEach(w => {
      w.type = "custom";
      w.pattern = text;
    });
    
    dialog.step = "keywords_select_types";
    await saveDialog(env, userId, dialog);
    
    return sendMessage(token, chatId,
      `✅ Шаблон "${text}" применён к группе ${gIdx + 1}\n\n` +
      groupSummaryText(group),
      { reply_markup: inlineAddMoreGroups(dialog.data.keywordGroups.length) });
  }

  // Обработка ввода новой группы ключевых слов
  if (dialog.step === "keywords_input") {
    const parsed = parseGroupInput(text);
    if (parsed.length === 0) {
      return sendMessage(token, chatId, "⚠️ Введите хотя бы одно слово.");
    }
    
    // Создаём группу: каждое слово (в т.ч. каждое слово фразы) — отдельный элемент.
    // Слова одной фразы связаны полем phraseGroup = полный текст фразы.
    const flatTokensNew = buildFlatTokens(parsed);
    const group = flatTokensNew.map(token => ({
      key:         token.key,
      word:        token.displayWord,
      type:        "partial",
      isPhrase:    token.isPhrase,
      phraseGroup: token.isPhrase ? token.fullPhrase : null,
    }));

    if (!dialog.data.keywordGroups) {
      dialog.data.keywordGroups = [];
    }
    dialog.data.keywordGroups.push(group);

    const groupIndex = dialog.data.keywordGroups.length - 1;
    dialog.step = "keywords_select_types";

    // Сохраняем parsedParts и flatTokens
    dialog.data.currentParsedParts = parsed;
    dialog.data.currentFlatTokens = flatTokensNew;

    // Строим wordTypes по ключу токена
    const wordTypes = {};
    group.forEach(w => {
      wordTypes[w.key] = "partial";
    });
    
    await saveDialog(env, userId, dialog);
    
    return sendMessage(token, chatId,
      wordTypesHelpText() + "\n\n" + groupSummaryText(group),
      { reply_markup: inlineWordTypeChoice(
        dialog.data.currentFlatTokens,
        wordTypes,
        groupIndex
      )});
  }

  // Обработка ввода максимальной цены
  if (dialog.step === "max_price") {
    const val = parseFloat(text.replace(/\s/g, "").replace(",", "."));
    if (isNaN(val) || val <= 0) {
      return sendMessage(token, chatId,
        `⚠️ Введите положительное число, например: <code>5000</code>\n\nИли нажмите «Без ограничения».`,
        { reply_markup: inlineMaxPriceSkip() });
    }
    dialog.data.max_price = val;
    const categories = await getCategories(env);
    return finishSubscription(token, chatId, userId, null, dialog, env, categories);
  }

  return null;
}

async function finishSubscription(token, chatId, userId, msgId, dialog, env, categories) {
  const subs = await getSubs(env, userId);
  if (subs.length >= MAX_SUBS) {
    await deleteDialog(env, userId);
    return sendMessage(token, chatId, `⚠️ Достигнут лимит подписок (${MAX_SUBS}).`);
  }

  // Очищаем временные данные перед сохранением
  delete dialog.data.currentFlatTokens;
  delete dialog.data.currentParsedParts;
  delete dialog.data.customGroupIndex;

  let sub;
  if (dialog.data.source === "rechitsa") {
    sub = {
      id:       shortUUID(),
      source:   "rechitsa",
      keywords: dialog.data.keywordGroups || dialog.data.keywords || [],
    };
  } else if (dialog.data.source === "torgigov") {
    sub = {
      id:         shortUUID(),
      source:     "torgigov",
      categories: dialog.data.categories || [],
      region:     dialog.data.region     || "all",
      keywords:   dialog.data.keywordGroups || dialog.data.keywords || [],
      max_price:  dialog.data.max_price  || 0,
    };
  } else {
    sub = {
      id:         shortUUID(),
      source:     "eauction",
      type:       dialog.data.type       || "auction",
      categories: dialog.data.categories || [],
      region:     dialog.data.region     || "keywords",
      keywords:   dialog.data.keywordGroups || dialog.data.keywords || [],
      max_price:  dialog.data.max_price  || 0,
    };
  }

  subs.push(sub);
  await saveSubs(env, userId, subs);
  await deleteDialog(env, userId);

  const text = `✅ <b>Подписка создана:</b>\n\n${subSummary(sub, categories)}`;
  if (msgId) return editMessage(token, chatId, msgId, text);
  return sendMessage(token, chatId, text);
}

// ── /list ─────────────────────────────────────────────────────

async function sendListMessage(token, chatId, userId, env, categories, editMsgId = null) {
  const subs = await getSubs(env, userId);
  if (!subs.length) {
    const text = "📋 У вас нет активных подписок.\n\nСоздайте новую командой /subscribe";
    if (editMsgId) return editMessage(token, chatId, editMsgId, text);
    return sendMessage(token, chatId, text);
  }
  let text = `📋 <b>Ваши подписки</b> (${subs.length}/${MAX_SUBS}):\n\n`;
  const keyboard = [];
  subs.forEach((sub, i) => {
    text += `<b>${i + 1}.</b> ${subSummary(sub, categories)}\n\n`;
    keyboard.push([{ text: `❌ Удалить подписку ${i + 1}`, callback_data: `del:${sub.id}` }]);
  });
  const reply_markup = { inline_keyboard: keyboard };
  if (editMsgId) return editMessage(token, chatId, editMsgId, text, { reply_markup });
  return sendMessage(token, chatId, text, { reply_markup });
}

// ── Telegram update handler ───────────────────────────────────

async function handleTelegramUpdate(update, env) {
  const token = env.BOT_TOKEN;

  if (update.callback_query) return handleCallback(token, update, env);

  if (update.my_chat_member) {
    const status = update.my_chat_member.new_chat_member?.status;
    if (status === "member") {
      const chatId = update.my_chat_member.chat.id;
      await setMyCommands(token);
      return sendMessage(token, chatId, helpText(), { reply_markup: mainReplyKeyboard() });
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text   = msg.text.trim();

  if (text === "/start" || text === "/help" || text === "❓ Справка") {
    await setMyCommands(token);
    return sendMessage(token, chatId, helpText(), { reply_markup: mainReplyKeyboard(), disable_web_page_preview: true });
  }
  if (text === "/subscribe" || text === "➕ Подписаться")
    return startSubscribeDialog(token, chatId, userId, env);
  if (text === "/list" || text === "📋 Мои подписки") {
    const categories = await getCategories(env);
    return sendListMessage(token, chatId, userId, env, categories);
  }
  if (text === "/unsubscribe_all" || text === "🗑 Удалить все подписки") {
    await saveSubs(env, userId, []);
    return sendMessage(token, chatId, "✅ Все подписки удалены.");
  }

  await handleTextInDialog(token, chatId, userId, text, env);
}

function helpText() {
  return (
    `👋 <b>Бот мониторинга торгов и аренды</b>\n\n` +
    `Отправляю уведомления о новых лотах и публикациях.\n\n` +
    `<b>Источники:</b>\n` +
    `• 🏛 <a href="https://e-auction.by">e-auction.by</a> — аукционы и фиксированная цена\n` +
    `• 🏙 <a href="https://rechitsa.by/gosim">rechitsa.by/gosim</a> — приобретение и аренда недвижимости\n` +
    `• 🏦 <a href="https://torgi.gov.by">torgi.gov.by</a> — государственная торговая площадка\n\n` +
    `Используйте кнопки меню ниже 👇`
  );
}

// ── Fetch handler ─────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/webhook") {
        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
          return new Response("Forbidden", { status: 403 });
        }
        const update = await request.json();
        await handleTelegramUpdate(update, env);
        return new Response("OK");
      }
      return new Response("Bot Worker — OK", { status: 200 });
    } catch (e) {
      console.error("CRASH:", e.message, e.stack);
      return new Response("OK");
    }
  },
};
