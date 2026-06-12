/**
 * shared/region.js
 *
 * Общая логика регионов — используется в bot/index.js (UI)
 * и во всех воркерах-парсерах (eauction, torgigov, butb, ...).
 */

import { matchKeywords } from "./matchKeyword.js";

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
 * @param {string|string[]|"all"|"keywords"} region        - sub.region
 * @param {string} locationText                             - lot.location (или searchText целиком)
 * @param {Array}  [regionKeywords]                         - sub.regionKeywords, группы токенов
 *                                                             (используются только если region === "keywords")
 * @returns {boolean}
 */
export function matchRegion(region, locationText, regionKeywords) {
  if (!region || region === "all") return true;

  if (region === "keywords") {
    // Если отдельные региональные ключевые слова не заданы — не блокируем
    // (старые подписки, где регион проверялся через общие keywords)
    if (!regionKeywords || regionKeywords.length === 0) return true;
    return matchKeywords((locationText || "").toLowerCase(), regionKeywords);
  }

  const regions = Array.isArray(region) ? region : [region];
  const loc      = (locationText || "").toLowerCase();
  return regions.some(r => loc.includes(r.toLowerCase()));
}
