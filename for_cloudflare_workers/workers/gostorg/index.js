// ============================================================
// workers/gostorg/index.js 
//
// Bindings:
//   KV:      GOSTORG_STORAGE, SUBSCRIBERS
//   Secrets: BOT_TOKEN, PARSER_SECRET
//
// Сайт gostorg.by отдаёт последние ~20 лотов прямо на главной
// странице (новые лоты всегда сверху), без пагинации и без
// открытого JSON API — поэтому парсер каждый день снимает только
// главную страницу и сверяет верхние 20 карточек со списком
// известных id (полноценный обход разделов не нужен).
//
// Endpoints:
//   GET  /known-lots           → [lotId, ...]
//   GET  /status               → {last_full_reset, snapshot_ts, last_daily_run}
//   POST /snapshot             → {snapshot: [lotId, ...]}
//   POST /add-lots             → {lot_ids: [...]}
//   POST /save-daily-lots      → {date, lots: [...], ttl}
//   POST /save-daily-run       → {date, lots_found}
//   POST /send-notifications   → {date}
//   POST /fetch-page           → {url} → {ok, status, html}
//       Для парсинга главной страницы (SSR, Bitrix).
// ============================================================

import { matchKeywords }                       from "../../shared/matchKeyword.js";
import { sendNotifications }                   from "../../shared/subscribers.js";
import { escapeHtml, jsonResponse, checkAuth } from "../../shared/format.js";
import { matchRegion }                         from "../../shared/region.js";
import { recordDigest }                        from "../../shared/digest.js";

// Ограничение размера known_lots — top-20 в день, но держим запас на случай
// пропущенных запусков.
const MAX_KNOWN_LOTS = 500;

// ── Матчинг подписки ───────────────────────────────────────

function parsePriceByn(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\s/g, "").replace(",", ".").replace(/BYN/i, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function matchLot(lot, sub) {
  if (!sub.source) return false;
  if (sub.source === "multi") {
    if (!(sub.sources || []).includes("gostorg")) return false;
  } else if (sub.source !== "gostorg") {
    return false;
  }

  if (!matchRegion(sub.region, lot.location || "", sub.regionKeywords, sub)) return false;

  const text = [lot.title, lot.location, lot.description].join(" ").toLowerCase();
  if (!matchKeywords(text, sub.keywords)) return false;

  if (sub.max_price > 0) {
    const num = parsePriceByn(lot.price);
    if (num !== null && num > sub.max_price) return false;
  }

  return true;
}

function formatLotMessage(lot) {
  let msg = `🏛 <a href="${lot.url}">${escapeHtml(lot.title)}</a>`;

  const tags = [];
  if (lot.is_new)                    tags.push("🆕 Новый лот");
  if (lot.discount_percent)          tags.push(`🔥 Скидка ${lot.discount_percent}%`);
  if (tags.length)                   msg += `\n${tags.join(" · ")}`;

  if (lot.price)      msg += `\n💰 ${escapeHtml(lot.price)}`;
  if (lot.location)   msg += `\n📍 ${escapeHtml(lot.location)}`;
  if (lot.auction_date) msg += `\n📅 Электронные торги: ${escapeHtml(lot.auction_date)}`;
  if (lot.description) {
    const desc = lot.description.length > 300
      ? lot.description.slice(0, 300).trimEnd() + "…"
      : lot.description;
    msg += `\n📄 ${escapeHtml(desc)}`;
  }
  return msg;
}

// ════════════════════════════════════════════════════════════
// HANDLERS
// ════════════════════════════════════════════════════════════

// Проксирует fetch() к gostorg.by для SSR-страницы (главная)
const ALLOWED_HOSTS = ["gostorg.by"];

async function handleFetchPage(body) {
  const { url } = body || {};
  if (!url) return new Response(JSON.stringify({ ok: false, error: "Missing url" }), { status: 400 });

  let parsed;
  try { parsed = new URL(url); } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid url" }), { status: 400 });
  }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return new Response(JSON.stringify({ ok: false, error: `Only ${ALLOWED_HOSTS.join(", ")} allowed` }), { status: 403 });
  }

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":               "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":                   "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":          "ru-RU,ru;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
      cf: { cacheTtl: 0 },
    });
    const html = await resp.text();
    return new Response(
      JSON.stringify({ ok: true, status: resp.status, html }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 502 });
  }
}

// GET /known-lots
async function handleGetKnownLots(env) {
  const raw = await env.GOSTORG_STORAGE.get("known_lots");
  return jsonResponse(raw ? JSON.parse(raw) : []);
}

// GET /status
async function handleGetStatus(env) {
  const [last_full_reset, snapshot_ts, last_daily_run] = await Promise.all([
    env.GOSTORG_STORAGE.get("last_full_reset"),
    env.GOSTORG_STORAGE.get("snapshot_timestamp"),
    env.GOSTORG_STORAGE.get("last_daily_run"),
  ]);
  return jsonResponse({ last_full_reset, snapshot_ts, last_daily_run, current_time: new Date().toISOString() });
}

// POST /save-daily-run {date, lots_found}
async function handleSaveDailyRun(body, env) {
  const ts = new Date().toISOString();
  await env.GOSTORG_STORAGE.put("last_daily_run", JSON.stringify({
    ts,
    date:       body.date       ?? ts.slice(0, 10),
    lots_found: body.lots_found ?? 0,
  }));
  return jsonResponse({ ok: true, ts });
}

// POST /snapshot  {snapshot: [lotId, ...]}
async function handleSnapshot(body, env) {
  const ids = (body.snapshot || []).map(String);
  await env.GOSTORG_STORAGE.put("known_lots", JSON.stringify(ids.slice(0, MAX_KNOWN_LOTS)));
  const ts = new Date().toISOString();
  await env.GOSTORG_STORAGE.put("snapshot_timestamp", ts);
  await env.GOSTORG_STORAGE.put("last_full_reset", ts);
  return jsonResponse({ ok: true, ts, count: ids.length });
}

// POST /add-lots  {lot_ids: [...]}
async function handleAddLots(body, env) {
  const { lot_ids } = body;
  if (!Array.isArray(lot_ids)) return new Response("Bad request", { status: 400 });

  const raw      = await env.GOSTORG_STORAGE.get("known_lots");
  const existing = raw ? JSON.parse(raw) : [];
  const existingSet = new Set(existing);
  const newIds   = lot_ids.map(String).filter(id => !existingSet.has(id));

  const combined = [...newIds, ...existing].slice(0, MAX_KNOWN_LOTS);
  await env.GOSTORG_STORAGE.put("known_lots", JSON.stringify(combined));
  return jsonResponse({ ok: true, added: newIds.length, total: combined.length });
}

// POST /save-daily-lots  {date, lots: [...], ttl}
async function handleSaveDailyLots(body, env) {
  const { date, lots, ttl } = body;
  if (!date || !Array.isArray(lots)) return new Response("Bad request", { status: 400 });
  await env.GOSTORG_STORAGE.put(
    `daily_lots:${date}`,
    JSON.stringify(lots),
    { expirationTtl: ttl || 86400 }
  );
  return jsonResponse({ ok: true, count: lots.length });
}

// POST /send-notifications  {date}
async function handleSendNotifications(body, env) {
  const { date } = body;
  if (!date) return new Response("Missing date", { status: 400 });

  const lotsRaw = await env.GOSTORG_STORAGE.get(`daily_lots:${date}`);
  if (!lotsRaw) return jsonResponse({ ok: true, sent: 0, reason: "no lots" });

  const lots  = JSON.parse(lotsRaw);
  const items = lots.map(lot => ({
    text:    formatLotMessage(lot),
    matchFn: sub => matchLot(lot, sub),
  }));

  const { sent, perUser } = await sendNotifications(items, env.SUBSCRIBERS, env.BOT_TOKEN);

  // Разбивка по типу отметки — новый лот / со скидкой (единственная
  // категоризация, которую можно снять с карточки на главной странице)
  const categories = {};
  for (const lot of lots) {
    if (lot.is_new)           categories["🆕 Новые лоты"]  = (categories["🆕 Новые лоты"]  || 0) + 1;
    if (lot.discount_percent) categories["🔥 Со скидкой"]  = (categories["🔥 Со скидкой"]  || 0) + 1;
  }

  await recordDigest(env, {
    source: "gostorg", newLots: lots.length, categories, perUser, date,
  });

  return jsonResponse({ ok: true, sent });
}

// ── Fetch handler ──────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      const url    = new URL(request.url);
      const path   = url.pathname;
      const method = request.method;

      if (!checkAuth(request, env)) return new Response("Unauthorized", { status: 401 });

      // GET endpoints
      if (method === "GET" && path === "/known-lots") return handleGetKnownLots(env);
      if (method === "GET" && path === "/status")     return handleGetStatus(env);

      // POST endpoints
      const body = await request.json().catch(() => null);
      if (!body) return new Response("Bad JSON", { status: 400 });

      if (method === "POST" && path === "/snapshot")           return handleSnapshot(body, env);
      if (method === "POST" && path === "/add-lots")           return handleAddLots(body, env);
      if (method === "POST" && path === "/save-daily-lots")    return handleSaveDailyLots(body, env);
      if (method === "POST" && path === "/send-notifications") return handleSendNotifications(body, env);
      if (method === "POST" && path === "/fetch-page")         return handleFetchPage(body);
      if (method === "POST" && path === "/save-daily-run")     return handleSaveDailyRun(body, env);

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error("CRASH:", e.message, e.stack);
      return new Response("Internal Error", { status: 500 });
    }
  },
};
