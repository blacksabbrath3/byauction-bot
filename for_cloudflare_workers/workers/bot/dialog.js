/**
 * bot/dialog.js — Диалог подписки: handleCallback, handleTextInDialog, finishSubscription.
 */

import { sendMessage, editMessage, answerCallback, deleteMessage } from "../../shared/telegram.js";
import { sourceById } from "../../shared/sources.js";
import {
  getSubs, saveSubs, getDialog, saveDialog, deleteDialog,
  getCategories,
} from "./kv.js";
import {
  MAX_KEYWORD_GROUPS,
  inlineSourceChoice, inlineMultiSourcePick, inlineTypeChoice,
  inlineRegion, inlineOblasts, inlineDistricts, inlineAfterDistrict,
  inlineWordTypeChoice, inlineKeywordsSkip, inlineMaxPriceSkip, inlineAddMoreGroups,
} from "./keyboards.js";
import {
  shortUUID, subSummary,
  categoryStepText, maxPricePromptText, keywordsPromptText,
  wordTypesHelpText, customPatternHelpText,
  currentGroupsSummary, groupSummaryText,
} from "./steps.js";
import { parseGroupInput, buildFlatTokens } from "./keywords.js";

const MAX_SUBS = 3;

// ── Активные группы ключевых слов (регион / лот) ──────────────
// dialog.data.keywordPhase === "region" → работаем с regionKeywordGroups
// иначе (по умолчанию "lot")            → работаем с keywordGroups

function activeGroups(dialog) {
  return dialog.data.keywordPhase === "region"
    ? (dialog.data.regionKeywordGroups ||= [])
    : (dialog.data.keywordGroups ||= []);
}

/** После завершения ввода региональных ключевых слов переходим к лот-ключевым. */
async function proceedToLotKeywords(token, chatId, msgId, userId, dialog, env) {
  dialog.data.keywordPhase = "lot";
  dialog.data.keywordGroups = [];
  dialog.step = "keywords_input";
  await saveDialog(env, userId, dialog);
  await clearKeywordsForceReply(token, chatId, dialog);
  return promptKeywordsInput(token, chatId, msgId,
    keywordsPromptText(dialog.data.source, "lot") + currentGroupsSummary([]),
    "Введите слова через запятую, например: Минск, авто", dialog, env, userId);
}

/**
 * Показывает приглашение ввести ключевые слова.
 * Редактирует предыдущее сообщение (кнопка «Пропустить») и
 * отправляет новое с force_reply — Telegram автоматически
 * фокусирует поле ввода с подсказкой над ним.
 */
/**
 * Показывает приглашение ввести ключевые слова.
 * При наличии msgId — редактирует сообщение и шлёт force_reply,
 * сохраняя его ID в dialog.data.kwForceReplyMsgId для последующего удаления.
 */
async function promptKeywordsInput(token, chatId, msgId, promptText, placeholder, dialog, env, userId) {
  if (msgId) {
    await editMessage(token, chatId, msgId, promptText, { reply_markup: inlineKeywordsSkip() });
    const frMsg = await sendMessage(token, chatId, `✏️ <i>Введите ответ в поле ниже:</i>`, {
      reply_markup: {
        force_reply:             true,
        input_field_placeholder: placeholder || "Слова через запятую...",
        selective:               true,
      },
    });
    if (dialog && frMsg?.result?.message_id) {
      dialog.data.kwForceReplyMsgId = frMsg.result.message_id;
      await saveDialog(env, userId, dialog);
    }
    return frMsg;
  } else {
    return sendMessage(token, chatId, promptText, { reply_markup: inlineKeywordsSkip() });
  }
}

/** Удаляет висящее force_reply сообщение ввода ключевых слов если оно есть. */
async function clearKeywordsForceReply(token, chatId, dialog) {
  const id = dialog.data.kwForceReplyMsgId;
  if (id) {
    await deleteMessage(token, chatId, id).catch(() => {});
    delete dialog.data.kwForceReplyMsgId;
  }
}

/**
 * Отправляет экран выбора типов совпадений в два сообщения:
 * 1. Описание типов (текст) — пользователь читает его
 * 2. Кнопки выбора — в фокусе, сразу доступны
 * Так описание остаётся видимым над кнопками без скролла.
 */
async function sendWordTypeScreen(token, chatId, helpText, summaryText, keyboard) {
  await sendMessage(token, chatId, helpText);
  return sendMessage(token, chatId, summaryText, { reply_markup: keyboard });
}

// ── Начало диалога ────────────────────────────────────────────

export async function startSubscribeDialog(token, chatId, userId, env) {
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

// ── handleCallback ────────────────────────────────────────────

export async function handleCallback(token, update, env) {
  const cb     = update.callback_query;
  const userId = String(cb.from.id);
  const chatId = cb.message.chat.id;
  const msgId  = cb.message.message_id;
  const data   = cb.data;

  await answerCallback(token, cb.id);

  if (data === "sub_cancel") {
    await deleteDialog(env, userId);
    return editMessage(token, chatId, msgId, "❌ Создание подписки отменено.");
  }

  if (data.startsWith("del:")) {
    const subs = await getSubs(env, userId);
    const idx  = subs.findIndex(s => s.id === data.slice(4));
    if (idx === -1) return editMessage(token, chatId, msgId, "⚠️ Подписка не найдена.");
    subs.splice(idx, 1);
    await saveSubs(env, userId, subs);
    const categories = await getCategories(env);
    return sendListMessage(token, chatId, userId, env, categories, msgId);
  }

  if (data === "noop") return;

  const dialog = await getDialog(env, userId);
  if (!dialog) {
    return sendMessage(token, chatId, "⚠️ Сессия истекла. Начните заново: /subscribe");
  }

  // ── Шаг 0: выбор источника ───────────────────────────────────
  if (data.startsWith("sub_src:") && dialog.step === "source") {
    const source = data.slice(8);
    dialog.data.source = source;

    if (source === "multi") {
      dialog.step = "multi_sources";
      dialog.data.multiSources = [];
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — несколько сайтов сразу</b>\n\nШаг 1 из 3 — Выберите сайты (можно несколько):`,
        { reply_markup: inlineMultiSourcePick([]) });
    }

    if (source === "rechitsa") {
      dialog.step = "keywords_input";
      dialog.data.keywordGroups = [];
      await saveDialog(env, userId, dialog);
      return promptKeywordsInput(token, chatId, msgId,
        keywordsPromptText("rechitsa") + currentGroupsSummary(dialog.data.keywordGroups),
        "Например: склад, Минск, авто", dialog, env, userId);
    }

    if (source === "torgigov") {
      // Категории torgigov — ОТКЛЮЧЕНО, подписка только по ключевым словам
      dialog.data.categories = [];
      dialog.step = "region";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — torgi.gov.by</b>\n\nШаг 1 из 2 — Выберите регион:`,
        { reply_markup: inlineRegion() });
    }

    if (source === "butb") {
      dialog.step = "region";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — БУТБ (et.butb.by)</b>\n\nШаг 1 из 2 — Выберите регион:`,
        { reply_markup: inlineRegion() });
    }

    // eauction
    dialog.step = "type";
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📋 <b>Новая подписка — e-auction.by</b>\n\nШаг 1 из 3 — Что отслеживать?`,
      { reply_markup: inlineTypeChoice() });
  }

  // ── Мультиподписка: выбор сайтов ─────────────────────────────
  if (data.startsWith("sub_msc:") && dialog.step === "multi_sources") {
    const id = data.slice(8);
    let selected = dialog.data.multiSources || [];

    if (id === "done") {
      if (selected.length === 0) {
        return answerCallback(token, cb.id, "⚠️ Выберите хотя бы один сайт");
      }
      const needRegion = selected.some(s => sourceById(s)?.hasRegion);
      if (needRegion) {
        dialog.step = "multi_region";
        await saveDialog(env, userId, dialog);
        return editMessage(token, chatId, msgId,
          `📋 <b>Несколько сайтов</b>\n\nШаг 2 из 3 — Выберите регион поиска:`,
          { reply_markup: inlineRegion() });
      } else {
        dialog.step = "keywords_input";
        dialog.data.keywordGroups = [];
        dialog.data.region = "all";
        await saveDialog(env, userId, dialog);
        return promptKeywordsInput(token, chatId, msgId,
        keywordsPromptText("multi") + currentGroupsSummary([]),
        "Например: склад, Минск, авто", dialog, env, userId);
      }
    }

    selected = selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id];
    dialog.data.multiSources = selected;
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📋 <b>Новая подписка — несколько сайтов сразу</b>\n\nШаг 1 из 3 — Выберите сайты (можно несколько):`,
      { reply_markup: inlineMultiSourcePick(selected) });
  }

  // ── Мультиподписка: регион ────────────────────────────────────
  if (dialog.step === "multi_region") {
    if (data === "sub_reg:all") {
      dialog.data.region = "all";
      dialog.step = "keywords_input";
      dialog.data.keywordGroups = [];
      await saveDialog(env, userId, dialog);
      return promptKeywordsInput(token, chatId, msgId,
        keywordsPromptText("multi", "lot") + currentGroupsSummary([]),
        "Например: склад, Минск, авто", dialog, env, userId);
    }
    if (data === "sub_reg:words") {
      dialog.data.region = "keywords";
      dialog.step = "region_keywords_input";
      dialog.data.regionKeywordGroups = []; dialog.data.keywordPhase = "region";
      await saveDialog(env, userId, dialog);
      return promptKeywordsInput(token, chatId, msgId,
        keywordsPromptText("multi", "region") + currentGroupsSummary([]),
        "Например: Гомель, Жлобин", dialog, env, userId);
    }
    if (data === "sub_reg:oblast") {
      dialog.step = "multi_region_oblast";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Несколько сайтов</b>\n\nВыберите область:`,
        { reply_markup: inlineOblasts() });
    }
  }


  // ── torgigov: категории — ОТКЛЮЧЕНО ──────────────────────────
  // Шаг убран: подписка только по ключевым словам.
  // if (data.startsWith("sub_tgc:") && dialog.step === "torgigov_categories") { ... }

  // ── eauction: тип лота (чекбоксы, можно выбрать оба) ─────────
  if (data.startsWith("sub_t:") && dialog.step === "type") {
    const val = data.slice(6);

    if (!dialog.data.selectedTypes) dialog.data.selectedTypes = [];
    const sel = dialog.data.selectedTypes;

    if (val === "done") {
      if (sel.length === 0) {
        await answerCallback(token, cb.id, "Выберите хотя бы один вариант");
        return;
      }
      dialog.data.type       = sel; // ["auction"] | ["fixed"] | ["auction","fixed"]
      dialog.data.categories = []; // категории не собираем
      dialog.step            = "region";
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📋 <b>Новая подписка — e-auction.by</b>\n\nШаг 2 из 2 — Выберите регион:`,
        { reply_markup: inlineRegion() });
    }

    // Тогл
    const idx = sel.indexOf(val);
    if (idx === -1) sel.push(val); else sel.splice(idx, 1);
    dialog.data.selectedTypes = sel;
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📋 <b>Новая подписка — e-auction.by</b>\n\nШаг 1 из 2 — Что отслеживать? (можно выбрать оба):`,
      { reply_markup: inlineTypeChoice(sel) });
  }

  // ── eauction: категории — ОТКЛЮЧЕНО ──────────────────────────
  // Шаг убран: подписка только по ключевым словам.
  // if (data.startsWith("sub_c:") && dialog.step === "categories") { ... }

  // ── Регион (общий для eauction, butb, torgigov) ───────────────
  if (data === "sub_reg:all") {
    dialog.data.region = "all";
    dialog.step = "keywords_input";
    dialog.data.keywordGroups = [];
    await saveDialog(env, userId, dialog);
    return promptKeywordsInput(token, chatId, msgId,
        keywordsPromptText(dialog.data.source, "lot") + currentGroupsSummary([]),
        "Например: склад, Минск, авто", dialog, env, userId);
  }

  if (data === "sub_reg:oblast") {
    dialog.step = "region_oblast";
    await saveDialog(env, userId, dialog);
    const src = dialog.data.source;
    const title = `📋 <b>Новая подписка — ${src === "butb" ? "БУТБ (et.butb.by)" : "e-auction.by"}</b>\n\nВыберите область:`;
    return editMessage(token, chatId, msgId, title, { reply_markup: inlineOblasts() });
  }

  if (data.startsWith("sub_obl:") && (dialog.step === "region_oblast" || dialog.step === "multi_region_oblast")) {
    const oblast = data.slice(8);
    dialog.data.region           = [oblast];
    dialog.data.regionOblast     = oblast;
    dialog.data.regionDistricts  = [];
    dialog.step = "region_district";
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📍 <b>${oblast} область</b>\n\nВыберите районы (можно несколько) или нажмите «☑️ Все районы»:`,
      { reply_markup: inlineDistricts(oblast, []) });
  }

  // ── Выбор районов ──────────────────────────────────────────────
  if (data.startsWith("sub_dst:") && dialog.step === "region_district") {
    const val    = data.slice(8);
    const oblast = dialog.data.regionOblast;
    let selected = dialog.data.regionDistricts || [];

    if (val === "all") {
      selected = [];
      dialog.data.regionDistricts = [];
      await saveDialog(env, userId, dialog);
      return editMessage(token, chatId, msgId,
        `📍 <b>${oblast} область</b>\n\n☑️ Выбраны все районы. Нажмите «✔️ Готово»:`,
        { reply_markup: inlineDistricts(oblast, []) });
    }

    if (val === "done") {
      await saveDialog(env, userId, dialog);
      const distLabel = selected.length > 0
        ? selected.join(", ")
        : "все районы";
      return editMessage(token, chatId, msgId,
        `📍 <b>${oblast} область</b>${selected.length > 0 ? ` — ${distLabel}` : ""}\n\nЗавершить или уточнить населённый пункт?`,
        { reply_markup: inlineAfterDistrict() });
    }

    selected = selected.includes(val)
      ? selected.filter(d => d !== val)
      : [...selected, val];
    dialog.data.regionDistricts = selected;
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📍 <b>${oblast} область</b>\n\nВыберите районы (можно несколько):`,
      { reply_markup: inlineDistricts(oblast, selected) });
  }

  // ── Сельсовет ──────────────────────────────────────────────────
  if (data === "sub_council:skip") {
    dialog.data.regionCouncil = "";
    await saveDialog(env, userId, dialog);
    // Переходим к следующему шагу (keywords или lot keywords)
    if (dialog.data.keywordPhase === "region") {
      return proceedToLotKeywords(token, chatId, msgId, userId, dialog, env);
    }
    return promptKeywordsInput(token, chatId, msgId,
      keywordsPromptText(dialog.data.source, "lot") + currentGroupsSummary([]),
      "Например: склад, авто", dialog, env, userId);
  }

  if (data === "sub_council:enter") {
    dialog.step = "region_council";
    await saveDialog(env, userId, dialog);
    await editMessage(token, chatId, msgId,
      `📍 <b>Населённый пункт</b>\n\nВведите название населённого пункта (можно часть):`,
      { reply_markup: { inline_keyboard: [[{ text: "⏭ Пропустить", callback_data: "sub_council:skip" }, { text: "❌ Отмена", callback_data: "sub_cancel" }]] } });
    return sendMessage(token, chatId, `✏️ <i>Введите название населённого пункта</i>`, {
      reply_markup: { force_reply: true, input_field_placeholder: "Введите название населённого пункта", selective: true },
    });
  }

  if (data === "sub_reg:words") {
    dialog.data.region = "keywords";
    dialog.step = "region_keywords_input";
    dialog.data.regionKeywordGroups = []; dialog.data.keywordPhase = "region";
    await saveDialog(env, userId, dialog);
    return promptKeywordsInput(token, chatId, msgId,
        keywordsPromptText(dialog.data.source, "region") + currentGroupsSummary([]),
        "Например: Гомель, Жлобин", dialog, env, userId);
  }

  // ── Ключевые слова: пропустить ────────────────────────────────
  if (data === "sub_kw:skip") {
    if (dialog.data.keywordPhase === "region") {
      dialog.data.regionKeywordGroups = [];
      return proceedToLotKeywords(token, chatId, msgId, userId, dialog, env);
    }

    // Фаза "lot" — завершаем подписку
    dialog.data.keywords = dialog.data.keywordGroups || [];
    if (dialog.data.source === "rechitsa") {
      dialog.data.max_price = 0;
      const categories = await getCategories(env);
      return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
    }
    if (dialog.data.source === "butb" || dialog.data.source === "multi" || dialog.data.source === "torgigov") {
      dialog.data.max_price = 0;
      const categories = await getCategories(env);
      return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
    }
    dialog.step = "max_price";
    await saveDialog(env, userId, dialog);
    await editMessage(token, chatId, msgId,
      maxPricePromptText(dialog.data.source), { reply_markup: inlineMaxPriceSkip() });
    const frMsg = await sendMessage(token, chatId, `✏️ <i>Введите число, например: <code>5000</code></i>`, {
      reply_markup: { force_reply: true, input_field_placeholder: "Введите сумму в BYN...", selective: true },
    });
    dialog.data.priceForceReplyMsgId = frMsg?.result?.message_id;
    await saveDialog(env, userId, dialog);
    return frMsg;
  }

  // ── Максимальная цена: пропустить ─────────────────────────────
  if (data === "sub_mp:skip") {
    dialog.data.max_price = 0;
    if (dialog.data.priceForceReplyMsgId) {
      await deleteMessage(token, chatId, dialog.data.priceForceReplyMsgId).catch(() => {});
      delete dialog.data.priceForceReplyMsgId;
    }
    const categories = await getCategories(env);
    return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
  }

  // ── Выбор типа совпадения слова ───────────────────────────────
  if (data.startsWith("sub_wt|")) {
    const [, gIdx, tIdx, type] = data.split("|");
    const groupIdx = parseInt(gIdx);
    const tokenIdx = parseInt(tIdx);
    const groups   = activeGroups(dialog);

    if (!groups[groupIdx]) {
      return answerCallback(token, cb.id, "Ошибка: группа не найдена");
    }
    const flatToken = dialog.data.currentFlatTokens?.[tokenIdx];
    if (!flatToken) {
      return answerCallback(token, cb.id, "Ошибка: токен не найден");
    }

    const group     = groups[groupIdx];
    const groupItem = group.find(w => w.key === flatToken.key);
    if (!groupItem) return answerCallback(token, cb.id, "Ошибка: слово не найдено");

    groupItem.type = type;
    if (type !== "custom") delete groupItem.pattern;

    await saveDialog(env, userId, dialog);

    const wordTypes = {};
    group.forEach(w => { wordTypes[w.key] = w.type || "partial"; });

    return sendWordTypeScreen(token, chatId,
      wordTypesHelpText(),
      groupSummaryText(group),
      inlineWordTypeChoice(dialog.data.currentFlatTokens, wordTypes, groupIdx));
  }

  // ── Подтвердить типы слов ─────────────────────────────────────
  if (data.startsWith("sub_wt_done|")) {
    const groupIdx = parseInt(data.split("|")[1]);
    const groups   = activeGroups(dialog);
    if (!groups[groupIdx]) {
      return answerCallback(token, cb.id, "Ошибка: группа не найдена");
    }

    const group = groups[groupIdx];
    group.forEach(w => { if (!w.type) w.type = "partial"; });

    delete dialog.data.currentFlatTokens;
    delete dialog.data.currentParsedParts;

    // Удаляем висящий force_reply
    await clearKeywordsForceReply(token, chatId, dialog);

    // В фазе региона — сразу переходим к ключевым словам лота
    if (dialog.data.keywordPhase === "region") {
      return proceedToLotKeywords(token, chatId, msgId, userId, dialog, env);
    }

    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📝 <b>Группа ${groupIdx + 1} сохранена</b>\n\n` +
      groupSummaryText(group) +
      currentGroupsSummary(groups),
      { reply_markup: inlineAddMoreGroups(groups.length) });
  }

  // ── Добавить ещё группу ───────────────────────────────────────
  if (data === "sub_kg:add") {
    const groups = activeGroups(dialog);
    if (groups.length >= MAX_KEYWORD_GROUPS) {
      return answerCallback(token, cb.id, `Максимум ${MAX_KEYWORD_GROUPS} групп`);
    }
    dialog.step = dialog.data.keywordPhase === "region" ? "region_keywords_input" : "keywords_input";
    await saveDialog(env, userId, dialog);
    return editMessage(token, chatId, msgId,
      `📝 Введите слова для группы ${groups.length + 1}:\n\n` +
      `<b>Пример:</b> <code>Минск, Советская, авто</code>\n\n` +
      `Слова разделяются запятой — все должны встретиться в тексте.` +
      currentGroupsSummary(groups),
      { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "sub_cancel" }]] } });
  }

  // ── Завершить ввод групп ──────────────────────────────────────
  if (data === "sub_kg:done") {
    if (dialog.data.keywordPhase === "region") {
      return proceedToLotKeywords(token, chatId, msgId, userId, dialog, env);
    }

    dialog.data.keywords = dialog.data.keywordGroups || [];
    const src = dialog.data.source;
    if (src === "rechitsa" || src === "butb" || src === "multi") {
      dialog.data.max_price = 0;
      const categories = await getCategories(env);
      return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
    }
    if (src === "torgigov") {
      dialog.data.max_price = 0;
      const categories = await getCategories(env);
      return finishSubscription(token, chatId, userId, msgId, dialog, env, categories);
    }
    dialog.step = "max_price";
    await saveDialog(env, userId, dialog);
    await editMessage(token, chatId, msgId,
      maxPricePromptText(src), { reply_markup: inlineMaxPriceSkip() });
    const frMsg = await sendMessage(token, chatId, `✏️ <i>Введите число, например: <code>5000</code></i>`, {
      reply_markup: { force_reply: true, input_field_placeholder: "Введите сумму в BYN...", selective: true },
    });
    dialog.data.priceForceReplyMsgId = frMsg?.result?.message_id;
    await saveDialog(env, userId, dialog);
    return frMsg;
  }

  // ── Расширенный поиск ─────────────────────────────────────────
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

  // ── Назад к типам слов ────────────────────────────────────────
  if (data.startsWith("sub_back_to_types|")) {
    const gIdx   = parseInt(data.split("|")[1]);
    const groups = activeGroups(dialog);
    dialog.step  = dialog.data.keywordPhase === "region" ? "region_keywords_select_types" : "keywords_select_types";
    if (!groups[gIdx]) {
      return answerCallback(token, cb.id, "Ошибка: группа не найдена");
    }

    const group = groups[gIdx];
    dialog.data.currentFlatTokens = group.map(w => ({
      key:         w.key,
      displayWord: w.word,
      fullPhrase:  w.phraseGroup || w.word,
      isPhrase:    w.isPhrase || false,
      phraseIdx:   0,
      wordIdx:     0,
    }));

    const wordTypes = {};
    group.forEach(w => { wordTypes[w.key] = w.type || "partial"; });

    await saveDialog(env, userId, dialog);
    return sendWordTypeScreen(token, chatId,
      wordTypesHelpText(),
      groupSummaryText(group),
      inlineWordTypeChoice(dialog.data.currentFlatTokens, wordTypes, gIdx));
  }
}

// ── handleTextInDialog ────────────────────────────────────────

export async function handleTextInDialog(token, chatId, userId, text, env) {
  const dialog = await getDialog(env, userId);
  if (!dialog) return null;

  if (dialog.step === "custom_pattern") {
    const gIdx   = dialog.data.customGroupIndex;
    const groups = activeGroups(dialog);
    if (!groups[gIdx]) {
      return sendMessage(token, chatId, "⚠️ Ошибка: группа не найдена.");
    }
    const group = groups[gIdx];
    group.forEach(w => { w.type = "custom"; w.pattern = text; });
    dialog.step = dialog.data.keywordPhase === "region" ? "region_keywords_select_types" : "keywords_select_types";
    await saveDialog(env, userId, dialog);
    return sendMessage(token, chatId,
      `✅ Шаблон "${text}" применён к группе ${gIdx + 1}\n\n` + groupSummaryText(group),
      { reply_markup: inlineAddMoreGroups(groups.length) });
  }

  if (dialog.step === "keywords_input" || dialog.step === "region_keywords_input") {
    await clearKeywordsForceReply(token, chatId, dialog);
    const parsed = parseGroupInput(text);
    if (parsed.length === 0) {
      return sendMessage(token, chatId, "⚠️ Введите хотя бы одно слово.");
    }

    const flatTokensNew = buildFlatTokens(parsed);
    const group = flatTokensNew.map(token => ({
      key:         token.key,
      word:        token.displayWord,
      type:        "partial",
      isPhrase:    token.isPhrase,
      phraseGroup: token.isPhrase ? token.fullPhrase : null,
    }));

    const groups = activeGroups(dialog);
    groups.push(group);
    const groupIndex = groups.length - 1;
    dialog.step = dialog.data.keywordPhase === "region" ? "region_keywords_select_types" : "keywords_select_types";
    dialog.data.currentParsedParts = parsed;
    dialog.data.currentFlatTokens  = flatTokensNew;

    const wordTypes = {};
    group.forEach(w => { wordTypes[w.key] = "partial"; });

    await saveDialog(env, userId, dialog);
    return sendWordTypeScreen(token, chatId,
      wordTypesHelpText(),
      groupSummaryText(group),
      inlineWordTypeChoice(flatTokensNew, wordTypes, groupIndex));
  }

  if (dialog.step === "region_council") {
    dialog.data.regionCouncil = text.trim();
    dialog.data.keywordGroups = [];
    // Всегда переходим к ключевым словам лота — без лишнего force_reply
    return proceedToLotKeywords(token, chatId, null, userId, dialog, env);
  }

  if (dialog.step === "max_price") {
    const val = parseFloat(text.replace(/\s/g, "").replace(",", "."));
    if (isNaN(val) || val <= 0) {
      return sendMessage(token, chatId,
        `⚠️ Введите положительное число, например: <code>5000</code>\n\nИли нажмите «Без ограничения».`,
        { reply_markup: inlineMaxPriceSkip() });
    }
    dialog.data.max_price = val;
    if (dialog.data.priceForceReplyMsgId) {
      await deleteMessage(token, chatId, dialog.data.priceForceReplyMsgId).catch(() => {});
      delete dialog.data.priceForceReplyMsgId;
    }
    const categories = await getCategories(env);
    return finishSubscription(token, chatId, userId, null, dialog, env, categories);
  }

  return null;
}

// ── finishSubscription ────────────────────────────────────────

export async function finishSubscription(token, chatId, userId, msgId, dialog, env, categories) {
  const subs = await getSubs(env, userId);
  if (subs.length >= MAX_SUBS) {
    await deleteDialog(env, userId);
    return sendMessage(token, chatId, `⚠️ Достигнут лимит подписок (${MAX_SUBS}).`);
  }

  delete dialog.data.currentFlatTokens;
  delete dialog.data.currentParsedParts;
  delete dialog.data.customGroupIndex;

  let sub;
  const src = dialog.data.source;
  const regionKeywords  = dialog.data.regionKeywordGroups || [];
  const regionDistricts = dialog.data.regionDistricts     || [];
  const regionCouncil   = dialog.data.regionCouncil       || "";

  if (src === "multi") {
    sub = { id: shortUUID(), source: "multi", sources: dialog.data.multiSources || [],
            region: dialog.data.region || "all", regionKeywords, regionDistricts, regionCouncil,
            keywords: dialog.data.keywordGroups || [] };
  } else if (src === "rechitsa") {
    sub = { id: shortUUID(), source: "rechitsa",
            keywords: dialog.data.keywordGroups || [] };
  } else if (src === "torgigov") {
    sub = { id: shortUUID(), source: "torgigov", categories: dialog.data.categories || [],
            region: dialog.data.region || "all", regionKeywords, regionDistricts, regionCouncil,
            keywords: dialog.data.keywordGroups || [],
            max_price: dialog.data.max_price || 0 };
  } else if (src === "butb") {
    sub = { id: shortUUID(), source: "butb", region: dialog.data.region || "all",
            regionKeywords, regionDistricts, regionCouncil,
            keywords: dialog.data.keywordGroups || [] };
  } else {
    sub = { id: shortUUID(), source: "eauction", type: dialog.data.type || "auction",
            categories: dialog.data.categories || [], region: dialog.data.region || "keywords",
            regionKeywords, regionDistricts, regionCouncil,
            keywords: dialog.data.keywordGroups || [], max_price: dialog.data.max_price || 0 };
  }

  subs.push(sub);
  await saveSubs(env, userId, subs);
  await deleteDialog(env, userId);

  const text = `✅ <b>Подписка создана:</b>\n\n${subSummary(sub, categories)}`;
  if (msgId) return editMessage(token, chatId, msgId, text);
  return sendMessage(token, chatId, text);
}

// ── sendListMessage ───────────────────────────────────────────

export async function sendListMessage(token, chatId, userId, env, categories, editMsgId = null) {
  const subs = await getSubs(env, userId);
  if (!subs.length) {
    const text = "📋 У вас нет активных подписок.\n\nСоздайте новую командой /subscribe";
    if (editMsgId) return editMessage(token, chatId, editMsgId, text);
    return sendMessage(token, chatId, text);
  }

  const lines = ["📋 <b>Ваши подписки:</b>\n"];
  subs.forEach((sub, i) => {
    lines.push(`${i + 1}. ${subSummary(sub, categories)}`);
  });

  const keyboard = {
    inline_keyboard: subs.map((sub, i) => ([{
      text: `🗑 Удалить подписку ${i + 1}`,
      callback_data: `del:${sub.id}`,
    }])),
  };

  const text = lines.join("\n");
  if (editMsgId) return editMessage(token, chatId, editMsgId, text, { reply_markup: keyboard });
  return sendMessage(token, chatId, text, { reply_markup: keyboard });
}
