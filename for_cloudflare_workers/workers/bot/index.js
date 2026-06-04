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
  if (d
