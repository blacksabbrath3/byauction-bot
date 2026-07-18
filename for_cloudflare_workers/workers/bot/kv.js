/**
 * bot/kv.js — Хелперы для KV-хранилища бота.
 */

export const DIALOG_TTL = 1800; // 30 мин

// ── Подписки ─────────────────────────────────────────────────

export async function getSubs(env, userId) {
  const raw = await env.SUBSCRIBERS.get(`sub:${userId}`);
  return raw ? JSON.parse(raw) : [];
}

export async function saveSubs(env, userId, subs) {
  await env.SUBSCRIBERS.put(`sub:${userId}`, JSON.stringify(subs));
}

// ── Диалог ───────────────────────────────────────────────────

export async function getDialog(env, userId) {
  const raw = await env.SUBSCRIBERS.get(`dialog:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function saveDialog(env, userId, data) {
  await env.SUBSCRIBERS.put(`dialog:${userId}`, JSON.stringify(data), {
    expirationTtl: DIALOG_TTL,
  });
}

export async function deleteDialog(env, userId) {
  await env.SUBSCRIBERS.delete(`dialog:${userId}`);
}

// ── Бонусные подписки (начисляются промокодами) ────────────────

export async function getBonusSubs(env, userId) {
  const raw = await env.SUBSCRIBERS.get(`bonus:${userId}`);
  return raw ? (parseInt(raw, 10) || 0) : 0;
}

export async function addBonusSubs(env, userId, amount) {
  const updated = (await getBonusSubs(env, userId)) + amount;
  await env.SUBSCRIBERS.put(`bonus:${userId}`, String(updated));
  return updated;
}

// ── Промокоды ────────────────────────────────────────────────
// promo:<CODE> = { bonus, used, createdBy, createdAt, usedBy?, usedAt? }

const PROMO_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих символов (0/O, 1/I)

function generatePromoCode(length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let code = "";
  for (let i = 0; i < length; i++) {
    code += PROMO_CODE_ALPHABET[bytes[i] % PROMO_CODE_ALPHABET.length];
  }
  return code;
}

/** Создаёт уникальный промокод, дающий `bonus` дополнительных подписок. */
export async function createPromoCode(env, bonus, createdBy) {
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generatePromoCode();
    const existing = await env.SUBSCRIBERS.get(`promo:${code}`);
    if (!existing) break;
  }
  await env.SUBSCRIBERS.put(`promo:${code}`, JSON.stringify({
    bonus, used: false, createdBy, createdAt: Date.now(),
  }));
  return code;
}

export async function getPromoCode(env, code) {
  const raw = await env.SUBSCRIBERS.get(`promo:${code}`);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Активирует промокод для пользователя.
 * @returns {{ok: true, bonus: number}|{ok: false, reason: "not_found"|"used"}}
 */
export async function redeemPromoCode(env, userId, rawCode) {
  const code = (rawCode || "").trim().toUpperCase();
  const promo = await getPromoCode(env, code);
  if (!promo) return { ok: false, reason: "not_found" };
  if (promo.used) return { ok: false, reason: "used" };

  promo.used   = true;
  promo.usedBy = userId;
  promo.usedAt = Date.now();
  await env.SUBSCRIBERS.put(`promo:${code}`, JSON.stringify(promo));

  await addBonusSubs(env, userId, promo.bonus);
  return { ok: true, bonus: promo.bonus };
}

// ── Категории ────────────────────────────────────────────────

const FALLBACK_CATEGORIES = [
  { slug: "auction",  label: "Аукцион" },
  { slug: "commerce", label: "Коммерческая продажа" },
];

const TORGIGOV_FALLBACK_CATEGORIES = [
  { slug: "nedvizhimost",          label: "Недвижимость"          },
  { slug: "transport-i-zapchasti", label: "Транспорт и запчасти"  },
  { slug: "oborudovanie",          label: "Оборудование"          },
  { slug: "komp-yutery",           label: "Компьютеры"            },
  { slug: "telefony-i-svyaz",      label: "Телефоны и связь"      },
  { slug: "mebel-i-inter-er",      label: "Мебель и интерьер"     },
  { slug: "produkty-pitaniya",     label: "Продукты питания"      },
  { slug: "tehnika-v-bytu",        label: "Техника в быту"        },
  { slug: "odezhda-obuv-i-dr",     label: "Одежда, обувь и др."   },
  { slug: "stroitel-stvo",         label: "Строительство"         },
  { slug: "nematerial-nye",        label: "Нематериальные"        },
  { slug: "pravo-arendy-i-uslugi", label: "Право аренды и услуги" },
  { slug: "zhivotnye-i-rasteniya", label: "Животные и растения"   },
];

export async function getCategories(env) {
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

export async function getTorgigovCategories(env) {
  try {
    const workerUrl = env.TORGIGOV_WORKER_URL;
    if (workerUrl) {
      const r = await fetch(`${workerUrl}/categories`, {
        headers: { "X-API-Key": env.PARSER_SECRET },
      });
      if (r.ok) {
        const cats = await r.json();
        if (Array.isArray(cats) && cats.length > 0) return cats;
      }
    }
  } catch (e) {
    console.warn("getTorgigovCategories fetch failed:", e.message);
  }
  return TORGIGOV_FALLBACK_CATEGORIES;
}
