/**
 * bot/keywords.js — Парсинг ключевых слов из ввода пользователя.
 */

/**
 * Разбивает ввод на токены для группы.
 * "Гомел, улица Советская, авто" →
 * [
 *   { word: "Гомел",            isPhrase: false, phraseWords: ["Гомел"] },
 *   { word: "улица Советская",  isPhrase: true,  phraseWords: ["улица", "Советская"] },
 *   { word: "авто",             isPhrase: false, phraseWords: ["авто"] },
 * ]
 */
export function parseGroupInput(input) {
  return input
    .split(",")
    .map(p => p.trim())
    .filter(Boolean)
    .map(part => {
      const hasSpace   = part.includes(" ");
      const phraseWords = hasSpace ? part.split(/\s+/).filter(Boolean) : [part];
      return { word: part, isPhrase: hasSpace, phraseWords };
    });
}

/**
 * Строит плоский список токенов для клавиатуры выбора типов слов.
 * Каждый токен: displayWord, fullPhrase, isPhrase, phraseIdx, wordIdx, key.
 */
export function buildFlatTokens(parsedParts) {
  const flat = [];
  parsedParts.forEach((part, phraseIdx) => {
    part.phraseWords.forEach((word, wordIdx) => {
      flat.push({
        displayWord: word,
        fullPhrase:  part.word,
        isPhrase:    part.isPhrase,
        phraseIdx,
        wordIdx,
        key: part.isPhrase ? `${part.word}|${word}` : word,
      });
    });
  });
  return flat;
}
