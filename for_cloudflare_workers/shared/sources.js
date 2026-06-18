/**
 * shared/sources.js
 *
 * Реестр всех источников.
 * Используется в bot/index.js — для показа списка при подписке,
 * а также для формирования "мультиподписки" (несколько сайтов сразу).
 */

export const SOURCES = [
  {
    id:          "eauction_auction",
    physicalId:  "eauction",
    eauctionType: "auction",
    label:       "🔨 e-auction.by — Аукционы",
    description: "Торги на повышение цены",
    hasRegion:   true,
  },
  {
    id:          "eauction_fixed",
    physicalId:  "eauction",
    eauctionType: "fixed",
    label:       "💰 e-auction.by — Фиксированная цена",
    description: "Продажа без торгов, по объявленной цене",
    hasRegion:   true,
  },
  {
    id:          "torgigov",
    physicalId:  "torgigov",
    label:       "🏦 torgi.gov.by",
    description: "Государственная торговая площадка",
    hasRegion:   true,
  },
  {
    id:          "butb",
    physicalId:  "butb",
    label:       "🏗 БУТБ (et.butb.by)",
    description: "Имущество — недвижимость, транспорт, оборудование",
    hasRegion:   true,
  },
  {
    id:          "rechitsa",
    physicalId:  "rechitsa",
    label:       "🏙 Речицкий райисполком",
    description: "Аренда и покупка недвижимости",
    hasRegion:   false,
  },
];

export function sourceById(id) {
  return SOURCES.find(s => s.id === id) || null;
}

/** Возвращает уникальный список физических источников (eauction_auction/eauction_fixed → eauction). */
export function physicalSourceIds(selectedIds) {
  const set = new Set();
  for (const id of selectedIds) {
    const s = sourceById(id);
    if (s) set.add(s.physicalId);
  }
  return [...set];
}
