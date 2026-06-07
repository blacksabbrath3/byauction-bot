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
//   POST /add-lots             → {slug, lot_ids: [...]}
//   POST /save-daily-lots      → {date, slug, lots: [...], ttl}
//   POST /send-notifications   → {date, slug}
//   POST /fetch-page           → {url} → {ok, status, html}
//       Проксирует GET к et.butb.by (недоступен с GitHub IP).
//   POST /fetch-form           → {url, form_data} → {ok, status, html}
//       Проксирует POST-запрос формы к et.butb.by (пагинация).
// ============================================================

import { matchKeywords }                       from "../../shared/matchKeyword.js";
import { sendNotifications }                   from "../../shared/subscribers.js";
import { escapeHtml, jsonResponse, checkAuth } from "../../shared/format.js";

// ── Константы ──────────────────────────────────────────────

const BUTB_BASE = "https://et.butb.by";

const PAGE_HEADERS = {
  "User-Agent":               "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":                   "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language":          "ru-RU,ru;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Origin":                   "https://et.butb.by",
  "Referer":                  "https://et.butb.by/et/auctions.xhtml",
};

// Рубрики сайта — slug → label (для уведомлений и хранения)
const RUBRIC_LABELS = {
  "all":           "🏛️ Все лоты",
  "realestate":    "🏠 Недвижимость",
  "land":          "🌍 Земельные участки",
  "transport":     "🚗 Транспорт и спецтехника",
  "equipment":     "⚙️ Станки и оборудование",
  "inventory":     "📦 Инвентарь и хоз. принадлежности",
  "other":         "📋 Другое имущество",
  "rent":          "🔑 Аренда",
  "construction":  "🏗️ Проектирование и строительство",
  "share":         "🤝 Доля в собственности",
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
    const resp = await fetch(url, {
      headers: PAGE_HEADERS,
      redirect: "follow",
      cf: { cacheTtl: 0 },
    });
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

  // form_data передаётся как строка URL-encoded
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...PAGE_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form_data,
      redirect: "follow",
      cf: { cacheTtl: 0 },
    });
    const html = await resp.text();
    return jsonResponse({ ok: true, status: resp.status, html });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message }, 502);
  }
}

// ── KV: known-lots ──────────────────────────────────────────

async function handleGetKnownLots(env) {
  const raw = await env.BUTB_STORAGE.get("known_lots");
  const data = raw ? JSON.parse(raw) : {};
  return jsonResponse(data);
}

// ── KV: status ─────────────────────────────────────────────

async function handleGetStatus(env) {
  const raw = await env.BUTB_STORAGE.get("status");
  const data = raw ? JSON.parse(raw) : {};
  return jsonResponse(data);
}

// ── POST /snapshot ──────────────────────────────────────────
// body: { snapshot: { slug: [lotId, ...] } }

async function handleSnapshot(body, env) {
  const { snapshot } = body || {};
  if (!snapshot || typeof snapshot !== "object") {
    return jsonResponse({ ok: false, error: "Missing snapshot" }, 400);
  }
  await env.BUTB_STORAGE.put("known_lots", JSON.stringify(snapshot));

  // Обновляем статус
  const rawStatus = await env.BUTB_STORAGE.get("status");
  const status = rawStatus ? JSON.parse(rawStatus) : {};
  const now = new Date().toISOString();
  status.snapshot_ts = now;
  status.last_full_reset = now;
  await env.BUTB_STORAGE.put("status", JSON.stringify(status));

  const total = Object.values(snapshot).reduce((s, arr) => s + arr.length, 0);
  return jsonResponse({ ok: true, saved: total });
}

// ── POST /add-lots ──────────────────────────────────────────
// body: { slug, lot_ids: [lotId, ...] }

async function handleAddLots(body, env) {
  const { slug, lot_ids } = body || {};
  if (!slug || !Array.isArray(lot_ids)) {
    return jsonResponse({ ok: false, error: "Missing slug or lot_ids" }, 400);
  }

  const raw = await env.BUTB_STORAGE.get("known_lots");
  const known = raw ? JSON.parse(raw) : {};
  const existing = known[slug] || [];

  // Добавляем новые в начало (новые лоты — наверху)
  const existingSet = new Set(existing);
  const newOnes = lot_ids.filter(id => !existingSet.has(id));
  if (newOnes.length > 0) {
    known[slug] = [...newOnes, ...existing];
    await env.BUTB_STORAGE.put("known_lots", JSON.stringify(known));
  }

  return jsonResponse({ ok: true, added: newOnes.length });
}

// ── POST /save-daily-lots ───────────────────────────────────
// body: { date, slug, lots: [{lotId, url, title, price, location, description, status, organizer, deadline, trade_date}], ttl }

async function handleSaveDailyLots(body, env) {
  const { date, slug, lots, ttl } = body || {};
  if (!date || !slug || !Array.isArray(lots)) {
    return jsonResponse({ ok: false, error: "Missing date, slug or lots" }, 400);
  }

  const key = `daily:${date}:${slug}`;
  const expirationTtl = ttl || 90 * 24 * 3600; // 90 дней по умолчанию
  await env.BUTB_STORAGE.put(key, JSON.stringify(lots), { expirationTtl });

  // Обновляем список дат
  const datesRaw = await env.BUTB_STORAGE.get("daily_dates");
  const dates = datesRaw ? JSON.parse(datesRaw) : [];
  if (!dates.includes(date)) {
    dates.unshift(date);
    dates.splice(30); // храним последние 30 дат
    await env.BUTB_STORAGE.put("daily_dates", JSON.stringify(dates));
  }

  return jsonResponse({ ok: true, saved: lots.length });
}

// ── POST /send-notifications ────────────────────────────────
// body: { date, slug }

async function handleSendNotifications(body, env) {
  const { date, slug } = body || {};
  if (!date || !slug) {
    return jsonResponse({ ok: false, error: "Missing date or slug" }, 400);
  }

  const key = `daily:${date}:${slug}`;
  const raw = await env.BUTB_STORAGE.get(key);
  if (!raw) return jsonResponse({ ok: false, error: "No data for this date/slug" }, 404);

  const lots = JSON.parse(raw);
  if (!lots.length) return jsonResponse({ ok: true, sent: 0 });

  const slugLabel = RUBRIC_LABELS[slug] || slug;

  // Формируем уведомления
  const messages = lots.map(lot => {
    const lines = [];
    lines.push(`<b>${escapeHtml(lot.title || "Без названия")}</b>`);
    if (lot.status)    lines.push(`Статус: ${escapeHtml(lot.status)}`);
    if (lot.price)     lines.push(`💰 <b>${escapeHtml(lot.price)}</b>`);
    if (lot.location)  lines.push(`📍 ${escapeHtml(lot.location)}`);
    if (lot.organizer) lines.push(`🏢 ${escapeHtml(lot.organizer)}`);
    if (lot.deadline)  lines.push(`⏰ Приём заявлений до: ${escapeHtml(lot.deadline)}`);
    if (lot.trade_date)lines.push(`📅 Торги: ${escapeHtml(lot.trade_date)}`);
    if (lot.description) {
      lines.push(`\n${escapeHtml(lot.description)}`);
    }
    lines.push(`\n🔗 <a href="${escapeHtml(lot.url)}">Открыть лот</a>`);
    return lines.join("\n");
  });

  const header = `${slugLabel} — новые лоты (${date}):\n`;
  const result = await sendNotifications(env, messages, header);
  return jsonResponse({ ok: true, ...result });
}

// ── Router ──────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // Auth
    if (!checkAuth(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      // GET endpoints
      if (method === "GET" && path === "/known-lots") return handleGetKnownLots(env);
      if (method === "GET" && path === "/status")     return handleGetStatus(env);

      // POST endpoints
      const body = method === "POST" ? await request.json() : null;

      if (method === "POST" && path === "/snapshot")           return handleSnapshot(body, env);
      if (method === "POST" && path === "/add-lots")           return handleAddLots(body, env);
      if (method === "POST" && path === "/save-daily-lots")    return handleSaveDailyLots(body, env);
      if (method === "POST" && path === "/send-notifications") return handleSendNotifications(body, env);
      if (method === "POST" && path === "/fetch-page")         return handleFetchPage(body);
      if (method === "POST" && path === "/fetch-form")         return handleFetchForm(body);

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
