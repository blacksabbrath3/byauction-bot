// ============================================================
// workers/torgigov/index.js — API для парсера torgi.gov.by
//
// Bindings (Cloudflare Worker Settings):
//   KV:      TORGIGOV_STORAGE → torgigov_storage
//            SUBSCRIBERS      → bot_subscribers
//   Secrets: BOT_TOKEN, PARSER_SECRET
//
// Endpoints:
//   GET  /known-lots          → {slug: [path, ...]}
//   GET  /categories          → [{slug, label, category_id}, ...]
//   GET  /status              → {last_full_reset, snapshot_ts, current_time}
//   POST /snapshot            → {snapshot: {slug: [path, ...]}}
//   POST /save-categories     → {categories: [...]}
//   POST /add-lots            → {slug, paths: [...]}
//   POST /save-daily-lots     → {date, slug, lots: [...], ttl}
//   POST /send-notifications  → {date, slug}
// ============================================================

import { matchKeywords }                        from "../../shared/matchKeyword.js";
import { sendNotifications }                    from "../../shared/subscribers.js";
import { escapeHtml, jsonResponse, checkAuth }  from "../../shared/format.js";

// ── Регионы Беларуси для нормализации ────────────────────────

const REGION_ALIASES = {
  "брестская": "Брестская",
  "витебская": "Витебская",
  "гомельская": "Гомельская",
  "гродненская": "Гродненская",
  "минская": "Минская",
  "могилёвская": "Могилёвская",
  "могилевская": "Могилёвская",
  "г. минск": "Минск",
  "г.минск": "Минск",
  "минск": "Минск",
};

function normalizeRegion(raw) {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  for (const [key, val] of Object.entries(REGION_ALIASES)) {
    if (lower.includes(key)) return val;
  }
  return raw;
}

// ── Цена ──────────────────────────────────────────────────────

function parsePriceByn(priceStr) {
  if (!priceStr) return null;
  const clean      = priceStr.replace(/BYN|Руб\.|руб\./gi, "").trim();
  const normalized = clean.replace(/\s/g, "").replace(",", ".");
  const val        = parseFloat(normalized);
  return isNaN(val) ? null : val;
}

// ── Матчинг ───────────────────────────────────────────────────

function matchLot(lot, sub) {
  if (!sub.source || sub.source !== "torgigov") return false;

  // Фильтр по категории (slug верхнего уровня или slug подкатегории из поля category)
  if (sub.categories?.length > 0) {
    const lotCat = (lot.category || "").toLowerCase();
    const lotSlug = lot.slug || "";
    const match = sub.categories.some(slug =>
      lotSlug === slug || lotCat.includes(slug.replace(/-/g, " "))
    );
    if (!match) return false;
  }

  // Фильтр по региону
  if (sub.region !== "all") {
    const regions  = Array.isArray(sub.region) ? sub.region : [sub.region];
    const lotRegion = normalizeRegion(lot.region || "").toLowerCase();
    const lotLoc    = (lot.location || "").toLowerCase();
    if (!regions.some(r => lotRegion.includes(r.toLowerCase()) || lotLoc.includes(r.toLowerCase()))) {
      return false;
    }
  }

  // Ключевые слова
  const text = [lot.title, lot.category, lot.location].join(" ").toLowerCase();
  if (!matchKeywords(text, sub.keywords)) return false;

  // Максимальная цена
  if (sub.max_price > 0) {
    const lotPrice = parsePriceByn(lot.price);
    if (lotPrice !== null && lotPrice > sub.max_price) return false;
  }

  return true;
}

// ── Форматирование ────────────────────────────────────────────

function formatLotMessage(lot) {
  let msg = `🏛 <a href="${lot.url}">${escapeHtml(lot.title)}</a>`;
  if (lot.price)    msg += `\n💰 Цена: ${escapeHtml(lot.price)}`;
  if (lot.region)   msg += `\n📍 ${escapeHtml(normalizeRegion(lot.region))}`;
  if (lot.location) msg += ` — ${escapeHtml(lot.location)}`;
  if (lot.category) msg += `\n🏷 ${escapeHtml(lot.category)}`;
  return msg;
}

// ── TOP_CATEGORIES — зеркало хардкода из torgigov_lib.py ─────
// Сайт Angular SPA, категории недоступны через парсинг.
// Обновлять синхронно с TOP_CATEGORIES в парсере.

const TOP_CATEGORIES = [
  { slug: "nedvizhimost",          label: "Недвижимость",           category_id: 1   },
  { slug: "transport-i-zapchasti", label: "Транспорт и запчасти",   category_id: 2   },
  { slug: "oborudovanie",          label: "Оборудование",           category_id: 3   },
  { slug: "komp-yutery",           label: "Компьютеры",             category_id: 4   },
  { slug: "telefony-i-svyaz",      label: "Телефоны и связь",       category_id: 5   },
  { slug: "mebel-i-inter-er",      label: "Мебель и интерьер",      category_id: 6   },
  { slug: "produkty-pitaniya",     label: "Продукты питания",       category_id: 7   },
  { slug: "tehnika-v-bytu",        label: "Техника в быту",         category_id: 8   },
  { slug: "odezhda-obuv-i-dr",     label: "Одежда, обувь и др.",    category_id: 9   },
  { slug: "stroitel-stvo",         label: "Строительство",          category_id: 10  },
  { slug: "nematerial-nye",        label: "Нематериальные",         category_id: 11  },
  { slug: "pravo-arendy-i-uslugi", label: "Право аренды и услуги",  category_id: 167 },
  { slug: "zhivotnye-i-rasteniya", label: "Животные и растения",    category_id: 164 },
];

// ── Handlers ──────────────────────────────────────────────────

async function handleGetKnownLots(env) {
  const raw = await env.TORGIGOV_STORAGE.get("known_lots");
  return jsonResponse(raw ? JSON.parse(raw) : {});
}

async function handleGetCategories(env) {
  const raw = await env.TORGIGOV_STORAGE.get("categories");
  // Если KV пуст (до первого snapshot) — отдаём встроенный список
  return jsonResponse(raw ? JSON.parse(raw) : TOP_CATEGORIES);
}

async function handleGetStatus(env) {
  const [last_full_reset, snapshot_ts] = await Promise.all([
    env.TORGIGOV_STORAGE.get("last_full_reset"),
    env.TORGIGOV_STORAGE.get("snapshot_timestamp"),
  ]);
  return jsonResponse({
    last_full_reset,
    snapshot_ts,
    current_time: new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }),
  });
}

async function handleSnapshot(body, env) {
  // body.snapshot = {slug: [path, ...]}
  const existing = await env.TORGIGOV_STORAGE.get("known_lots");
  const current  = existing ? JSON.parse(existing) : {};

  for (const [slug, paths] of Object.entries(body.snapshot || {})) {
    current[slug] = paths;
  }

  await env.TORGIGOV_STORAGE.put("known_lots", JSON.stringify(current));
  const ts = new Date().toISOString();
  await env.TORGIGOV_STORAGE.put("snapshot_timestamp", ts);
  await env.TORGIGOV_STORAGE.put("last_full_reset", ts);
  return jsonResponse({ ok: true, ts });
}

async function handleSaveCategories(body, env) {
  const { categories } = body;
  if (!Array.isArray(categories)) return new Response("Bad categories", { status: 400 });
  await env.TORGIGOV_STORAGE.put("categories", JSON.stringify(categories));
  return jsonResponse({ ok: true, count: categories.length });
}

async function handleAddLots(body, env) {
  const { slug, paths } = body;
  if (!slug || !Array.isArray(paths)) return new Response("Bad request", { status: 400 });

  const raw     = await env.TORGIGOV_STORAGE.get("known_lots");
  const current = raw ? JSON.parse(raw) : {};
  const existing = current[slug] || [];
  const existingSet = new Set(existing);
  const newPaths = paths.filter(p => !existingSet.has(p));

  // Новые вставляем в начало (rank 0 = самый новый)
  current[slug] = [...newPaths, ...existing];
  await env.TORGIGOV_STORAGE.put("known_lots", JSON.stringify(current));
  return jsonResponse({ ok: true, added: newPaths.length });
}

async function handleSaveDailyLots(body, env) {
  const { date, slug, lots, ttl } = body;
  if (!date || !slug || !Array.isArray(lots)) return new Response("Bad request", { status: 400 });

  await env.TORGIGOV_STORAGE.put(
    `daily_lots:${date}:${slug}`,
    JSON.stringify(lots),
    { expirationTtl: ttl || 86400 }
  );
  return jsonResponse({ ok: true, count: lots.length });
}

async function handleSendNotifications(body, env) {
  const { date, slug } = body;
  if (!date || !slug) return new Response("Missing date or slug", { status: 400 });

  const lotsRaw = await env.TORGIGOV_STORAGE.get(`daily_lots:${date}:${slug}`);
  if (!lotsRaw) return jsonResponse({ ok: true, sent: 0, reason: "no lots" });

  const lots  = JSON.parse(lotsRaw);
  const items = lots.map(lot => ({
    text:    formatLotMessage(lot),
    matchFn: sub => matchLot(lot, sub),
  }));

  const sent = await sendNotifications(items, env.SUBSCRIBERS, env.BOT_TOKEN);
  return jsonResponse({ ok: true, sent });
}

// ── Fetch handler ─────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      if (!checkAuth(request, env)) return new Response("Unauthorized", { status: 401 });

      const url    = new URL(request.url);
      const path   = url.pathname;
      const method = request.method;

      if (method === "GET" && path === "/known-lots")  return handleGetKnownLots(env);
      if (method === "GET" && path === "/categories")  return handleGetCategories(env);
      if (method === "GET" && path === "/status")      return handleGetStatus(env);

      const body = await request.json().catch(() => null);
      if (!body) return new Response("Bad JSON", { status: 400 });

      if (method === "POST" && path === "/snapshot")           return handleSnapshot(body, env);
      if (method === "POST" && path === "/save-categories")    return handleSaveCategories(body, env);
      if (method === "POST" && path === "/add-lots")           return handleAddLots(body, env);
      if (method === "POST" && path === "/save-daily-lots")    return handleSaveDailyLots(body, env);
      if (method === "POST" && path === "/send-notifications") return handleSendNotifications(body, env);

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error("CRASH:", e.message, e.stack);
      return new Response("Internal Error", { status: 500 });
    }
  },
};
