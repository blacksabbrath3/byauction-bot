/**
 * shared/sources.js
 *
 * Реестр всех источников.
 * Используется в bot/index.js — для показа списка при подписке,
 * а также для формирования "мультиподписки" (несколько сайтов сразу).
 */

export const SOURCES = [
  {
    id:          "eauction",
    label:       "🏛 e-auction.by",
    description: "Торги — аукционы и продажа по фиксированной цене",
    hasRegion:   true,
    hasKeywords: true,
  },
  {
    id:          "torgigov",
    label:       "🏦 torgi.gov.by",
    description: "Государственная торговая площадка",
    hasRegion:   true,
    hasKeywords: true,
  },
  {
    id:          "butb",
    label:       "🏗 БУТБ (et.butb.by)",
    description: "Имущество — недвижимость, транспорт, оборудование",
    hasRegion:   true,
    hasKeywords: true,
  },
  {
    id:          "rechitsa",
    label:       "🏙 Речицкий райисполком",
    description: "Аренда и покупка недвижимости",
    hasRegion:   false,
    hasKeywords: true,
  },
];

export function sourceById(id) {
  return SOURCES.find(s => s.id === id) || null;
}
