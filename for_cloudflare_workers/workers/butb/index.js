// ============================================================
// workers/butb/index.js
//
// Bindings:
//   KV:      BUTB_STORAGE, SUBSCRIBERS
//   Secrets: BOT_TOKEN, PARSER_SECRET
//
// Endpoints:
//   GET  /known-lots           → {slug: [lotId, ...]}
//   GET  /status               → {last_full_reset, snapshot_ts}
//   POST /snapshot             → {snapshot: {slug: [lotId, ...]}}
//   POST /save-categories      → {categories: [{slug, label}]}
//   POST /add-lots             → {slug, lot_ids: [...]}
//   POST /save-daily-lots      → {date, slug, lots: [...], ttl}
//   POST /save-daily-run       → {date, lots_found, categories}
//   POST /send-notifications   → {date, slug}
//   POST /fetch-page           → {url} → {ok, status, html}
//   POST /fetch-form           → {url, form_data} → {ok, status, html}
// ============================================================

import { matchKeywords }                       from "../../shared/matchKeyword.js";
import { sendNotifications }                   from "../../shared/subscribers.js";
import { escapeHtml, jsonResponse, checkAuth } from "../../shared/format.js";
import { matchRegion }                         from "../../shared/region.js";

// ── Константы ──────────────────────────────────────────────

const PAGE_HEADERS = {
  "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language":           "ru-RU,ru;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Origin":                    "https://et.butb.by",
  "Referer":                   "https://et.butb.by/et/auctions.xhtml",
};

// ── Прокси: GET страницы ────────────────────────────────────

async function handleFetchPage(body) {
  const { url } = body || {};
  if (!url) return jsonResponse({ ok: false, error: "Missing url" }, 400);

  let parsed;
  try { parsed = new URL(url); } catch {
    return jsonResponse({ ok: false, error: "Invalid url" }, 400);
  }
  if (parsed.hostname !== "et.butb.by") {
    return jsonResponse({ ok: false, error: "Only et.butb.by allowed" }, 403);
  }

  try {
    const resp = await fetch(url, { headers: PAGE_HEADERS, redirect: "follow" });
    const html = await resp.text();
    return jsonResponse({ ok: true, status: resp.status, html });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 502);
  }
}

// ── Прокси: POST формы (пагинация ICEFaces) ─────────────────

async function handleFetchForm(body) {
  const { url, form_data } = body || {};
  if (!url || !form_data) return jsonResponse({ ok: false, error: "Missing url or form_data" }, 400);

  let parsed;
  try { parsed = new URL(url); } catch {
    return jsonResponse({ ok: false, error: "Invalid url" }, 400);
  }
  if (parsed.hostname !== "et.butb.by") {
    return jsonResponse({ ok: false, error: "Only et.butb.by allowed" }, 403);
  }

  try {
    const resp = await fetch(url, {
      method:  "POST",
      headers: { ...PAGE_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      body:    form_data,
      redirect: "follow",
    });
    const html = await resp.text();
    return jsonResponse({ ok: true, status: resp.status, html });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 502);
  }
}

// ── GET /known-lots ─────────────────────────────────────────

async function handleGetKnownLots(env) {
  const raw = await env.BUTB_STORAGE.get("known_lots");
  return jsonResponse(raw ? JSON.parse(raw) : {});
}

// ── GET /status ─────────────────────────────────────────────

async function handleGetStatus(env) {
  const raw = await env.BUTB_STORAGE.get("status");
  return jsonResponse(raw ? JSON.parse(raw) : {});
}

// ── POST /snapshot ──────────────────────────────────────────

async function handleSnapshot(body, env) {
  const { snapshot } = body || {};
  if (!snapshot || typeof snapshot !== "object") {
    return jsonResponse({ ok: false, error: "Missing snapshot" }, 400);
  }
  await env.BUTB_STORAGE.put("known_lots", JSON.stringify(snapshot));

  const rawStatus = await env.BUTB_STORAGE.get("status");
  const status    = rawStatus ? JSON.parse(rawStatus) : {};
  const now       = new Date().toISOString();
  status.snapshot_ts    = now;
  status.last_full_reset = now;
  await env.BUTB_STORAGE.put("status", JSON.stringify(status));

  const total = Object.values(snapshot).reduce((s, arr) => s + arr.length, 0);
  return jsonResponse({ ok: true, saved: total });
}

// ── POST /save-categories ───────────────────────────────────

async function handleSaveCategories(body, env) {
  const { categories } = body || {};
  if (!Array.isArray(categories)) return jsonResponse({ ok: false, error: "Bad categories" }, 400);
  await env.BUTB_STORAGE.put("categories", JSON.stringify(categories));
  return jsonResponse({ ok: true, count: categories.length });
}

// ── POST /add-lots ──────────────────────────────────────────

async function handleAddLots(body, env) {
  const { slug, lot_ids } = body || {};
  if (!slug || !Array.isArray(lot_ids)) {
    return jsonResponse({ ok: false, error: "Missing slug or lot_ids" }, 400);
  }
  const raw      = await env.BUTB_STORAGE.get("known_lots");
  const known    = raw ? JSON.parse(raw) : {};
  const existing = new Set((known[slug] || []).map(String));
  const incoming = lot_ids.map(String);
  const newOnes  = incoming.filter(id => !existing.has(id));
  if (newOnes.length > 0) {
    known[slug] = [...newOnes, ...(known[slug] || [])];
    await env.BUTB_STORAGE.put("known_lots", JSON.stringify(known));
  }
  console.log(`add-lots: slug=${slug} incoming=${incoming.length} new=${newOnes.length}`);
  return jsonResponse({ ok: true, added: newOnes.length });
}

// ── POST /save-daily-lots ───────────────────────────────────

async function handleSaveDailyLots(body, env) {
  const { date, slug, lots, ttl } = body || {};
  if (!date || !slug || !Array.isArray(lots)) {
    return jsonResponse({ ok: false, error: "Missing date, slug or lots" }, 400);
  }
  const key            = `daily:${date}:${slug}`;
  const expirationTtl  = ttl || 90 * 24 * 3600;
  await env.BUTB_STORAGE.put(key, JSON.stringify(lots), { expirationTtl });

  const datesRaw = await env.BUTB_STORAGE.get("daily_dates");
  const dates    = datesRaw ? JSON.parse(datesRaw) : [];
  if (!dates.includes(date)) {
    dates.unshift(date);
    dates.splice(30);
    await env.BUTB_STORAGE.put("daily_dates", JSON.stringify(dates));
  }
  return jsonResponse({ ok: true, saved: lots.length });
}

// ── POST /save-daily-run ────────────────────────────────────

async function handleSaveDailyRun(body, env) {
  const { date, lots_found, categories } = body || {};
  if (!date) return jsonResponse({ ok: false, error: "Missing date" }, 400);
  const key = `run:${date}`;
  await env.BUTB_STORAGE.put(key, JSON.stringify({ date, lots_found, categories }), {
    expirationTtl: 90 * 24 * 3600,
  });
  return jsonResponse({ ok: true });
}

// ── POST /send-notifications ────────────────────────────────

async function handleSendNotifications(body, env) {
  const { date, slug } = body || {};
  if (!date || !slug) {
    return jsonResponse({ ok: false, error: "Missing date or slug" }, 400);
  }
  const raw = await env.BUTB_STORAGE.get(`daily:${date}:${slug}`);
  if (!raw) return jsonResponse({ ok: false, error: "No data for this date/slug" }, 404);

  const lots = JSON.parse(raw);
  if (!lots.length) return jsonResponse({ ok: true, sent: 0 });

  // Формируем items для sendNotifications из shared/subscribers.js
  const items = lots.map(lot => {
    const searchText = [
      lot.title || "",
      lot.location || "",
      lot.organizer || "",
      lot.description || "",
    ].join(" ").toLowerCase();

    const lines = [];
    lines.push(`🏗 <a href="${escapeHtml(lot.url)}">${escapeHtml(lot.title || "Без названия")}</a>`);
    if (lot.status)     lines.push(`Статус: ${escapeHtml(lot.status)}`);
    if (lot.lot_num)    lines.push(escapeHtml(lot.lot_num));
    if (lot.price)      lines.push(`💰 ${escapeHtml(lot.price)}`);
    if (lot.deposit)    lines.push(`Задаток: ${escapeHtml(lot.deposit)}`);
    if (lot.location)   lines.push(`📍 ${escapeHtml(lot.location)}`);
    if (lot.organizer)  lines.push(`🏢 ${escapeHtml(lot.organizer)}`);
    if (lot.deadline)   lines.push(`⏰ Приём заявлений до: ${escapeHtml(lot.deadline)}`);
    if (lot.trade_date) lines.push(`📅 Торги: ${escapeHtml(lot.trade_date)}`);

    return {
      text:    lines.join("\n"),
      matchFn: (sub) => {
        if (sub.source !== "butb" && sub.source !== "multi") return false;
        if (sub.source === "multi" && !(sub.sources || []).includes("butb")) return false;
        if (!matchRegion(sub.region, lot.location, sub.regionKeywords)) return false;
        return matchKeywords(searchText, sub.keywords);
      },
    };
  });

  const sent = await sendNotifications(items, env.SUBSCRIBERS, env.BOT_TOKEN);
  return jsonResponse({ ok: true, sent });
}

// ── Router ──────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // Диагностический endpoint — без авторизации
    if (path === "/ping") {
      return jsonResponse({ ok: true, worker: "butb-worker" });
    }

    if (!checkAuth(request, env)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    try {
      if (method === "GET"  && path === "/known-lots")        return handleGetKnownLots(env);
      if (method === "GET"  && path === "/status")            return handleGetStatus(env);

      const body = method === "POST" ? await request.json() : null;

      if (method === "POST" && path === "/snapshot")           return handleSnapshot(body, env);
      if (method === "POST" && path === "/save-categories")    return handleSaveCategories(body, env);
      if (method === "POST" && path === "/add-lots")           return handleAddLots(body, env);
      if (method === "POST" && path === "/save-daily-lots")    return handleSaveDailyLots(body, env);
      if (method === "POST" && path === "/save-daily-run")     return handleSaveDailyRun(body, env);
      if (method === "POST" && path === "/send-notifications") return handleSendNotifications(body, env);
      if (method === "POST" && path === "/fetch-page")         return handleFetchPage(body);
      if (method === "POST" && path === "/fetch-form")         return handleFetchForm(body);

      return jsonResponse({ ok: false, error: "Not Found" }, 404);
    } catch (e) {
      console.error("CRASH:", e.message, e.stack);
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  },
};
