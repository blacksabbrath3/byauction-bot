/**
 * shared/region.js
 *
 * Общая логика регионов — используется в bot/index.js (UI)
 * и во всех воркерах-парсерах (eauction, torgigov, butb, ...).
 */

export const REGIONS = [
  "Брестская",
  "Витебская",
  "Гомельская",
  "Гродненская",
  "Минская",
  "Могилёвская",
];

/**
 * Человекочитаемая метка для значения sub.region.
 * region может быть: "all" | "keywords" | ["Минская"] | "Минская"
 */
export function regionLabel(r) {
  if (!r || r === "all")      return "🌍 Вся страна";
  if (r === "keywords")       return "🔤 По ключевым словам";
  if (Array.isArray(r))       return r.join(", ");
  return r;
}

/**
 * Проверяет подходит ли locationText под регион подписки.
 *
 * @param {string|string[]|"all"|"keywords"} region  - sub.region
 * @param {string} locationText                       - lot.location (или searchText целиком)
 * @returns {boolean}
 *
 * Если region === "keywords" — регион проверяется через ключевые слова подписки,
 * matchRegion возвращает true (не блокирует), реальная проверка в matchKeywords.
 */
export function matchRegion(region, locationText) {
  if (!region || region === "all" || region === "keywords") return true;
  const regions = Array.isArray(region) ? region : [region];
  const loc     = (locationText || "").toLowerCase();
  return regions.some(r => loc.includes(r.toLowerCase()));
}
