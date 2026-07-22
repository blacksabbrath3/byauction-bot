// ============================================================
// workers/eauction/index.js — API для парсера e-auction.by
//
// Bindings (Cloudflare Worker Settings):
//   KV:      EAUCTION_STORAGE → eauction_storage
//            SUBSCRIBERS      → bot_subscribers
//   Secrets: BOT_TOKEN, PARSER_SECRET
//
// Прокси: POST /fetch-page {url} → {ok, status, html}
//   Cloudflare IP не блокируется e-auction.by (в отличие от GitHub Actions IP)
// ============================================================

import { matchKeywords }                        from "../../shared/matchKeyword.js";
import { sendNotifications }                    from "../../shared/subscribers.js";
import { escapeHtml, jsonResponse, checkAuth }  from "../../shared/format.js";
import { matchRegion }                          from "../../shared/region.js";
import { recordDigest }                         from "../../shared/digest.js";

// ── Константы ─────────────────────────────────────────────────

const AUCTION_SECTIONS = ["auction", "gos"];
const FIXED_SECTIONS   = ["shop", "showcase", "commerce"];
const ALL_SECTIONS     = [...AUCTION_SECTIONS, ...FIXED_SECTIONS];

// Ограничение размера списка known_lots на раздел — без этого список растёт
// бесконечно и JSON.parse/stringify на нём может упереться в CPU-лимит Worker'а.
// Старые лоты давно сняты с торгов и не нужны для дедупликации новых.
const MAX_KNOWN_LOTS = 5000;

const PAGE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control":   "no-cache",
};

// ── Прокси: GET страницы ────────────────────────────────────────

async function handleFetchPage(body) {
  const { url } = body || {};
  if (!url) return jsonResponse({ ok: false, error: "Missing url" }, 400);

  let parsed;
  try { parsed = new URL(url); } catch {
    return jsonResponse({ ok: false, error: "Invalid url" }, 400);
  }
  if (!["e-auction.by", "www.e-auction.by"].includes(parsed.hostname)) {
    return jsonResponse({ ok: false, error: "Only e-auction.by allowed" }, 403);
  }

  try {
    const resp = await fetch(url, { headers: PAGE_HEADERS, redirect: "follow" });
    const html = await resp.text();
    return jsonResponse({ ok: true, status: resp.status, html });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 502);
  }
}

const FALLBACK_CATEGORIES = [
  { slug: "legkovye_avtomobili",                            label: "Легковые автомобили" },
  { slug: "gruzovaya_tekhnika_i_avtobusy",                  label: "Грузовая техника и автобусы" },
  { slug: "mototekhnika_i_sredstva_personalnoy_mobilnosti",  label: "Мототехника" },
  { slug: "nedvizhimost",                                   label: "Недвижимость" },
  { slug: "spetstekhnika",                                  label: "Спецтехника" },
  { slug: "stanki_i_oborudovanie",                          label: "Станки и оборудование" },
  { slug: "dolya_v_ustavnom_fonde",                         label: "Доля в уставном фонде" },
  { slug: "predpriyatie_kak_imushchestvennyy_kompleks",     label: "Предприятие как имущ. комплекс" },
  { slug: "drugoe_imushchestvo",                            label: "Другое имущество" },
];

// ── Цена ──────────────────────────────────────────────────────

/**
 * Разбирает строку цены в BYN: "12 500.00 BYN", "280,00 BYN" и т.д.
 * Возвращает число или null.
 */
function parsePriceByn(priceStr) {
  if (!priceStr) return null;
  const clean      = priceStr.replace(/BYN|р\.|руб\./gi, "").trim();
  const normalized = clean.replace(/\s/g, "").replace(",", ".");
  const val        = parseFloat(normalized);
  return isNaN(val) ? null : val;
}

// ── Матчинг ───────────────────────────────────────────────────

function matchLot(lot, sub) {
  if (!sub.source) return false;
  if (sub.source === "multi") {
    if (!(sub.sources || []).includes("eauction")) return false;
  } else if (sub.source !== "eauction") {
    return false;
  }

  const isAuction = AUCTION_SECTIONS.includes(lot.section);

  // Для multi-подписки тип задаётся через sub.eauctionTypes (выбран явно при подписке).
  // Для прямой подписки на eauction — через sub.type (старый формат — строка или массив).
  const types = sub.source === "multi"
    ? (sub.eauctionTypes?.length > 0 ? sub.eauctionTypes : ["auction", "fixed"])
    : (Array.isArray(sub.type) ? sub.type : [sub.type || "auction"]);

  if (!types.includes("auction") && !types.includes("fixed")) return false;
  if (!types.includes("auction") &&  isAuction) return false;
  if (!types.includes("fixed")   && !isAuction) return false;

  if (!matchRegion(sub.region, lot.location, sub.regionKeywords, sub)) return false;

  const text = [lot.title, lot.description, lot.location].join(" ").toLowerCase();
  if (!matchKeywords(text, sub.keywords)) return false;

  if (sub.max_price > 0) {
    const lotPrice = parsePriceByn(lot.price);
    if (lotPrice !== null && lotPrice > sub.max_price) return false;
  }

  return true;
}

// ── Форматирование ────────────────────────────────────────────

function formatLotMessage(lot) {
  let msg = `🔔 <a href="${lot.url}">${escapeHtml(lot.title)}</a>`;
  if (lot.price)       msg += `\n💰 Цена: ${escapeHtml(lot.price)}`;
  if (lot.location)    msg += `\n📍 ${escapeHtml(lot.location)}`;
  if (lot.area)        msg += `\n📐 Площадь: ${escapeHtml(lot.area)} м²`;
  if (lot.description) {
    const desc = lot.description.slice(0, 300);
    msg += `\n📝 ${escapeHtml(desc)}${lot.description.length > 300 ? "…" : ""}`;
  }
  return msg;
}

// ── Handlers ──────────────────────────────────────────────────

async function handleGetKnownLots(env) {
  const result = {};
  for (const section of ALL_SECTIONS) {
    let raw;
    try {
      raw = await env.EAUCTION_STORAGE.get(`known_lots:${section}`);
    } catch (e) {
      console.error(`known_lots:${section} KV get failed:`, e.message);
      result[section] = [];
      continue;
    }

    if (!raw) { result[section] = []; continue; }

    let list;
    try {
      list = JSON.parse(raw);
    } catch (e) {
      console.error(`known_lots:${section} JSON.parse failed (corrupt?):`, e.message);
      result[section] = [];
      continue;
    }

    // Самовосстановление: если список разросся сверх лимита (например, после
    // долгого периода без дневных запусков) — обрезаем и пересохраняем сразу.
    if (Array.isArray(list) && list.length > MAX_KNOWN_LOTS) {
      list = list.slice(0, MAX_KNOWN_LOTS);
      await env.EAUCTION_STORAGE.put(`known_lots:${section}`, JSON.stringify(list));
    }

    result[section] = list;
  }
  return jsonResponse(result);
}

async function handleGetCategories(env) {
  const raw = await env.EAUCTION_STORAGE.get("auction_categories");
  return jsonResponse(raw ? JSON.parse(raw) : FALLBACK_CATEGORIES);
}

async function handleGetStatus(env) {
  const [last_full_reset, snapshot_ts, last_daily_run] = await Promise.all([
    env.EAUCTION_STORAGE.get("last_full_reset"),
    env.EAUCTION_STORAGE.get("snapshot_timestamp"),
    env.EAUCTION_STORAGE.get("last_daily_run"),
  ]);
  return jsonResponse({
    last_full_reset,
    snapshot_ts,
    last_daily_run: last_daily_run ? JSON.parse(last_daily_run) : null,
    current_time: new Date().toISOString(),
  });
}

async function handleSaveDailyRun(body, env) {
  const ts = new Date().toISOString();
  await env.EAUCTION_STORAGE.put("last_daily_run", JSON.stringify({
    ts,
    date:       body.date       ?? ts.slice(0, 10),
    lots_found: body.lots_found ?? 0,
  }));
  return jsonResponse({ ok: true, ts });
}

// Аварийная очистка одного раздела known_lots без чтения/парсинга текущего значения —
// полезно если список разросся настолько, что обычное чтение упирается в CPU-лимит.
async function handleResetKnownLots(body, env) {
  const { section } = body || {};
  if (section) {
    await env.EAUCTION_STORAGE.delete(`known_lots:${section}`);
    return jsonResponse({ ok: true, cleared: section });
  }
  await Promise.all(ALL_SECTIONS.map(s => env.EAUCTION_STORAGE.delete(`known_lots:${s}`)));
  return jsonResponse({ ok: true, cleared: ALL_SECTIONS });
}

async function handleSnapshot(body, env) {
  for (const [section, paths] of Object.entries(body.snapshot || {})) {
    await env.EAUCTION_STORAGE.put(`known_lots:${section}`, JSON.stringify(paths));
  }
  const ts = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  await env.EAUCTION_STORAGE.put("snapshot_timestamp", ts);
  await env.EAUCTION_STORAGE.put("last_full_reset", ts);
  return jsonResponse({ ok: true, ts });
}

async function handleSaveCategories(body, env) {
  const { categories } = body;
  if (!Array.isArray(categories)) return new Response("Bad categories", { status: 400 });
  await env.EAUCTION_STORAGE.put("auction_categories", JSON.stringify(categories));
  return jsonResponse({ ok: true, count: categories.length });
}

async function handleAddLots(body, env) {
  const { section, paths } = body;
  if (!section || !Array.isArray(paths)) return new Response("Bad request", { status: 400 });
  const raw      = await env.EAUCTION_STORAGE.get(`known_lots:${section}`);
  const existing = raw ? JSON.parse(raw) : [];
  const newPaths = paths.filter(p => !existing.includes(p));
  // Новые пути — впереди (более вероятны при будущих проверках), список обрезаем сверху.
  const combined = [...newPaths, ...existing].slice(0, MAX_KNOWN_LOTS);
  await env.EAUCTION_STORAGE.put(`known_lots:${section}`, JSON.stringify(combined));
  return jsonResponse({ ok: true, added: newPaths.length, total: combined.length });
}

async function handleSaveDailyLots(body, env) {
  const { date, section, lots, ttl } = body;
  if (!date || !section || !Array.isArray(lots)) return new Response("Bad request", { status: 400 });
  await env.EAUCTION_STORAGE.put(
    `daily_lots:${date}:${section}`,
    JSON.stringify(lots),
    { expirationTtl: ttl || 86400 }
  );
  return jsonResponse({ ok: true, count: lots.length });
}

async function handleSendNotifications(body, env) {
  const { date, section } = body;
  if (!date || !section) return new Response("Missing date or section", { status: 400 });

  const lotsRaw = await env.EAUCTION_STORAGE.get(`daily_lots:${date}:${section}`);
  if (!lotsRaw) {
    await recordDigest(env, { source: "eauction", newLots: 0, perUser: {}, date });
    return jsonResponse({ ok: true, sent: 0, reason: "no lots" });
  }

  const lots  = JSON.parse(lotsRaw);
  const items = lots.map(lot => ({
    text:    formatLotMessage(lot),
    matchFn: sub => matchLot(lot, sub),
  }));

  const { sent, perUser } = await sendNotifications(items, env.SUBSCRIBERS, env.BOT_TOKEN);

  // Разбивка по типу лота — аукцион / фиксированная цена
  const categories = {};
  for (const lot of lots) {
    const label = AUCTION_SECTIONS.includes(lot.section) ? "🔨 Аукцион" : "💰 Фикс. цена";
    categories[label] = (categories[label] || 0) + 1;
  }

  await recordDigest(env, {
    source: "eauction", newLots: lots.length, categories, perUser, date,
  });

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
      if (method === "GET" && path === "/status")      return handleGetStatus(env);
      if (method === "GET" && path === "/categories")  return handleGetCategories(env);

      const body = await request.json().catch(() => null);
      if (!body) return new Response("Bad JSON", { status: 400 });

      if (method === "POST" && path === "/snapshot")           return handleSnapshot(body, env);
      if (method === "POST" && path === "/reset-known-lots")   return handleResetKnownLots(body, env);
      if (method === "POST" && path === "/fetch-page")          return handleFetchPage(body);
      if (method === "POST" && path === "/save-categories")    return handleSaveCategories(body, env);
      if (method === "POST" && path === "/add-lots")           return handleAddLots(body, env);
      if (method === "POST" && path === "/save-daily-lots")    return handleSaveDailyLots(body, env);
      if (method === "POST" && path === "/save-daily-run")     return handleSaveDailyRun(body, env);
      if (method === "POST" && path === "/send-notifications") return handleSendNotifications(body, env);

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error("CRASH:", e.message, e.stack);
      return new Response("Internal Error", { status: 500 });
    }
  },
};
