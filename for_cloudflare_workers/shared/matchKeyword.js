export function escapeRegex(s) {
  return s.replace(/[-+^$.|?*{}()]/g, "\\$&");
}

/**
 * Проверяет один токен подписки против текста.
 * Форматы: строка (старый), { key, word, type, phraseGroup? } (новый).
 */
export function matchKeyword(text, w) {
  if (typeof w === "string") return text.includes(w.toLowerCase());

  const word = (w.word || "").toLowerCase();
  if (!word) return false;
  if (!w.key && w.isPhrase) return text.includes(word); // старый формат фразы

  switch (w.type) {
    case "exact":
      return new RegExp(
        "(?<![а-яёa-zA-Z0-9])" + escapeRegex(word) + "(?![а-яёa-zA-Z0-9])", "i"
      ).test(text);
    case "extended":
      return new RegExp(
        escapeRegex(word) + "[а-яёa-zA-Z]{0,3}(?![а-яёa-zA-Z])", "i"
      ).test(text);
    case "custom": {
      if (!w.pattern) return text.includes(word);
      const re = w.pattern.toLowerCase()
        .replace(/[-+^$.|{}()]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(re).test(text);
    }
    default:
      return text.includes(word);
  }
}

/** Проверяет группу токенов (все должны совпасть). */
export function matchGroup(text, group) {
  return group.every(w => matchKeyword(text, w));
}

/** Проверяет все группы (хотя бы одна должна совпасть). */
export function matchKeywords(text, keywords) {
  if (!keywords?.length) return true;
  return keywords.some(group => matchGroup(text, group));
}
