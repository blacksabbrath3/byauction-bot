/**
 * bot/steps.js — Тексты шагов диалога, subSummary, форматирование.
 */

import { regionLabel } from "../../shared/region.js";
import { sourceById  } from "../../shared/sources.js";
import { MAX_KEYWORD_GROUPS } from "./keyboards.js";

// ── Вспомогательные функции ───────────────────────────────────

export function shortUUID() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export function wordMatchTypeLabel(type) {
  switch (type) {
    case "partial":  return "частичное";
    case "exact":    return "точное";
    case "extended": return "расширенное";
    case "custom":   return "своё";
    default:         return "частичное";
  }
}

export function categoryLabels(categories, slugs) {
  if (!slugs || slugs.length === 0) return "✅ Все категории";
  return slugs.map(slug => {
    const c = categories.find(x => x.slug === slug);
    return c ? c.label : slug;
  }).join(", ");
}

export function formatKeywordGroups(groups) {
  return groups.map(group =>
    group.map(w => {
      let label = w.word;
      if (w.type && w.type !== "partial") {
        label += ` (${wordMatchTypeLabel(w.type)}`;
        if (w.pattern) label += `: ${w.pattern}`;
        label += `)`;
      }
      return label;
    }).join(" + ")
  ).join(", ");
}

// ── Сводка подписки ───────────────────────────────────────────

function regionLine(sub) {
  if (sub.region === "keywords" && sub.regionKeywords?.length > 0) {
    return `<b>Регион:</b> по словам — ${formatKeywordGroups(sub.regionKeywords)}`;
  }
  let line = `<b>Регион:</b> ${regionLabel(sub.region)}`;
  if (sub.regionDistricts?.length > 0) {
    line += ` → ${sub.regionDistricts.join(", ")}`;
  }
  if (sub.regionCouncilGroups?.length > 0) {
    line += ` → нп. ${formatKeywordGroups(sub.regionCouncilGroups)}`;
  }
  return line;
}

export function subSummary(sub, categories) {
  const kw = sub.keywords?.length > 0
    ? `<b>Ключевые слова:</b> ${formatKeywordGroups(sub.keywords)}`
    : "<b>Ключевые слова:</b> все уведомления";

  if (sub.source === "multi") {
    const srcLabels = (sub.sources || [])
      .map(id => sourceById(id)?.label || id)
      .join(", ");
    return [
      `🔀 <b>Несколько сайтов:</b> ${srcLabels}`,
      regionLine(sub),
      kw,
    ].join("\n");
  }

  if (sub.source === "rechitsa") {
    return ["🏙 <b>Речицкий райисполком</b> — приобретение и аренда", kw].join("\n");
  }

  if (sub.source === "torgigov") {
    return [
      "🏦 <b>torgi.gov.by</b> — государственная торговая площадка",
      regionLine(sub),
      kw,
      ...(sub.max_price > 0 ? [`<b>Макс. цена:</b> ${sub.max_price.toLocaleString("ru-RU")} BYN`] : []),
    ].join("\n");
  }

  if (sub.source === "butb") {
    return [
      "🏗 <b>БУТБ</b> — имущество (et.butb.by)",
      regionLine(sub),
      kw,
    ].join("\n");
  }

  // eauction (default)
  const types = Array.isArray(sub.type) ? sub.type : [sub.type || "auction"];
  const typeLabel = types.length >= 2
    ? "🔨 Аукцион + 💰 Фиксированная цена"
    : types[0] === "fixed" ? "💰 Фиксированная цена" : "🔨 Аукцион";
  return [
    `🏛 <b>e-auction.by</b> — ${typeLabel}`,
    regionLine(sub),
    kw,
    ...(sub.max_price > 0 ? [`<b>Макс. цена:</b> ${sub.max_price.toLocaleString("ru-RU")} BYN`] : []),
  ].join("\n");
}

// ── Тексты шагов ─────────────────────────────────────────────

function sourceHeader(source) {
  switch (source) {
    case "rechitsa": return "📋 <b>Новая подписка — Речицкий райисполком</b>";
    case "torgigov": return "📋 <b>Новая подписка — torgi.gov.by</b>";
    case "butb":     return "📋 <b>Новая подписка — БУТБ (et.butb.by)</b>";
    case "multi":    return "📋 <b>Новая подписка — несколько сайтов</b>";
    default:         return "📋 <b>Новая подписка — e-auction.by</b>";
  }
}

export function categoryStepText(selected, categories) {
  const selLine = selected.length > 0
    ? `\n\nВыбрано: ${selected.map(s => (categories.find(x => x.slug === s) || {}).label || s).join(", ")}`
    : "";
  return `📋 <b>Новая подписка — e-auction.by</b>\n\nВыберите категории (можно несколько):${selLine}\n\nНажмите «✔️ Готово» или «☑️ Все категории».`;
}

export function maxPricePromptText(source) {
  return (
    `${sourceHeader(source)}\n\n` +
    `Укажите максимальную цену в BYN (необязательно).\n\n` +
    `Лоты дороже этой суммы приходить <b>не будут</b>.\n` +
    `Лоты <b>без цены</b> приходят всегда.\n\n` +
    `Введите число, например: <code>5000</code>\n\n` +
    `Или нажмите «Без ограничения».`
  );
}

export function keywordsPromptText(source, target = "lot") {
  if (target === "region") {
    return (
      `${sourceHeader(source)}\n` +
      `〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n` +
      `📍 <b>Регион поиска</b>\n\n` +
      `Введите города, районы или области через <b>запятую</b>. ` +
      `Подойдут лоты, где хотя бы одно из слов встречается в адресе.\n\n` +
      `Для поиска фразы — разделяйте слова <b>пробелом</b>.\n\n` +
      `<b>Пример:</b> <code>Гомель, Жлобин, Гомельская область</code>\n\n` +
      `Или нажмите «Пропустить» — регион не будет ограничен.`
    );
  }

  return (
    `${sourceHeader(source)}\n` +
    `〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n` +
    `🔍 <b>Ключевые слова</b>\n\n` +
    `Введите слова или фразы через <b>запятую</b>. ` +
    `Все слова из группы должны встретиться в тексте лота.\n\n` +
    `Для поиска фразы — разделяйте слова <b>пробелом</b>.\n\n` +
    `<b>Пример:</b> <code>склад, улица Советская, авто</code>\n` +
    `<i>→ найдёт лоты где есть все три</i>\n\n` +
    `После ввода вы сможете настроить тип совпадения для каждого слова.\n\n` +
    `Или нажмите «Пропустить» — будут приходить все новые лоты.`
  );
}

export function wordTypesHelpText() {
  return (
    `<b>Типы совпадений:</b>\n\n` +
    `🔍 <b>Частичное</b> — слово найдётся как часть текста.\n` +
    `<i>Пример: Гомел → Гомель, Гомельский, Гомельской</i>\n\n` +
    `🎯 <b>Точное</b> — строгое совпадение целого слова.\n` +
    `<i>Пример: Гомель → только Гомель, но не Гомельский</i>\n\n` +
    `🔤 <b>Расширенное</b> — частичное + до 3 любых символов в конце.\n` +
    `<i>Пример: Советск → Советская, Советский, Советских</i>`
  );
}

export function customPatternHelpText() {
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

export function currentGroupsSummary(groups) {
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

export function groupSummaryText(group) {
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

export function helpText() {
  return (
    `👋 <b>Бот мониторинга торгов и аренды</b>\n\n` +
    `Отправляю уведомления о новых лотах и публикациях.\n\n` +
    `<b>Источники:</b>\n` +
    `• 🏛 <a href="https://e-auction.by">e-auction.by</a> — аукционы и фиксированная цена\n` +
    `• 🏙 <a href="https://rechitsa.by/gosim">rechitsa.by/gosim</a> — приобретение и аренда недвижимости\n` +
    `• 🏦 <a href="https://torgi.gov.by">torgi.gov.by</a> — государственная торговая площадка\n` +
    `• 🏗 <a href="https://et.butb.by">et.butb.by</a> — имущество БУТБ\n\n` +
    `Используйте кнопки меню ниже 👇`
  );
}
