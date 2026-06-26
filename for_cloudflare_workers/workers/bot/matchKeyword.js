export function escapeRegex(s) {
  return s.replace(/[-+^$.|?*{}()]/g, "\\$&");
}

/**
 * Проверяет один токен подписки против текста.
 * Форматы: строка (старый), { key, word, type, phraseGroup? } (новый).
 *
 * Слово с префиксом "-" — исключающее: matchGroup вернёт false если оно найдено.
 * Пример: { word: "-аренда" } → лот НЕ должен содержать "аренда".
 */
export function matchKeyword(text, w) {
  if (typeof w === "string") return text.includes(w.toLowerCase());

  const rawWord = (w.word || "").toLowerCase();
  if (!rawWord) return false;

  // Исключающее слово — проверяется отдельно в matchGroup
  if (rawWord.startsWith("-")) return true; // не фильтруем здесь

  if (!w.key && w.isPhrase) return text.includes(rawWord);

  switch (w.type) {
    case "exact":
      return new RegExp(
        "(?<![а-яёa-zA-Z0-9])" + escapeRegex(rawWord) + "(?![а-яёa-zA-Z0-9])", "i"
      ).test(text);
    case "extended":
      return new RegExp(
        escapeRegex(rawWord) + "[а-яёa-zA-Z]{0,3}(?![а-яёa-zA-Z])", "i"
      ).test(text);
    case "custom": {
      if (!w.pattern) return text.includes(rawWord);
      const pat = w.pattern.toLowerCase();
      // Если шаблон начинается с "-" — исключающий, обрабатывается в matchGroup
      if (pat.startsWith("-")) return true;
      const re = pat
        .replace(/[-+^$.|{}()]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(re).test(text);
    }
    default:
      return text.includes(rawWord);
  }
}

/**
 * Проверяет наличие исключающего (-) слова в тексте.
 * Возвращает true если найдено хотя бы одно слово под запретом.
 */
function hasExcludedWord(text, group) {
  for (const w of group) {
    const rawWord = typeof w === "string" ? w : (w.word || "");
    const pattern = typeof w === "string" ? null : (w.type === "custom" ? w.pattern : null);
    const checkWord = (pattern || rawWord).toLowerCase();

    if (!checkWord.startsWith("-")) continue;
    const excluded = checkWord.slice(1).trim();
    if (!excluded) continue;

    if (text.includes(excluded)) return true;
  }
  return false;
}

/** Проверяет группу токенов (все должны совпасть, ни одно исключение не должно сработать). */
export function matchGroup(text, group) {
  if (hasExcludedWord(text, group)) return false;
  return group.every(w => {
    const rawWord = typeof w === "string" ? w : (w.word || "");
    const checkWord = rawWord.toLowerCase();
    if (checkWord.startsWith("-")) return true; // уже проверено выше
    return matchKeyword(text, w);
  });
}

/** Проверяет все группы (хотя бы одна должна совпасть). */
export function matchKeywords(text, keywords) {
  if (!keywords?.length) return true;
  return keywords.some(group => matchGroup(text, group));
}
