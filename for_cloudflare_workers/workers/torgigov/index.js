// ============================================================
// workers/torgigov/index.js
//
// Bindings:
//   KV:      TORGIGOV_STORAGE, SUBSCRIBERS
//   Secrets: BOT_TOKEN, PARSER_SECRET
//
// Endpoints:
//   GET  /known-lots           → {slug: [lotId, ...]}
//   GET  /categories           → [{slug, label, category_id}, ...]
//   GET  /status               → {last_full_reset, snapshot_ts}
//   POST /snapshot             → {snapshot: {slug: [lotId, ...]}}
//   POST /save-categories      → {categories: [...]}
//   POST /add-lots             → {slug, lot_ids: [...]}
//   POST /save-daily-lots      → {date, lots: [...], ttl}
//   POST /send-notifications   → {date}
//   POST /fetch-page           → {url} → {ok, status, html}
//       Для парсинга главной страницы и страниц лотов (SSR).
//   GET  /api-lots?category=1&page=0&pagesize=50
//       Проксирует GET к api.torgi.gov.by/api/lots — недоступен с GitHub IP.
// ============================================================

import { matchKeywords }                       from "../../shared/matchKeyword.js";
import { sendNotifications }                   from "../../shared/subscribers.js";
import { escapeHtml, jsonResponse, checkAuth } from "../../shared/format.js";
import { matchRegion }                         from "../../shared/region.js";

// ── Константы ──────────────────────────────────────────────

const TORGI_API   = "https://api.torgi.gov.by/api";

// Ограничение размера known_lots — без этого список растёт бесконечно
// и JSON.parse/stringify на нём может упереться в CPU-лимит Worker'а.
const MAX_KNOWN_LOTS = 5000;

const API_HEADERS = {
  "User-Agent":  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept":      "application/json, text/plain, */*",
  "Referer":     "https://torgi.gov.by/",
  "Origin":      "https://torgi.gov.by",
};

// ── Регионы ────────────────────────────────────────────────

// Числовые ID регионов из API torgi.gov.by
const REGION_ID_MAP = {
  1: "Брестская", 2: "Витебская", 3: "Гомельская",
  4: "Гродненская", 5: "Минская", 6: "Могилёвская",
  7: "Брестская", 8: "Витебская", 9: "Гомельская",
  10: "Гродненская", 11: "Минская", 12: "Могилёвская",
  13: "Минск",
};

// ID верхнеуровневых категорий → название
const CATEGORY_ID_MAP = {
  1: "Недвижимость", 2: "Транспорт и запчасти", 3: "Оборудование",
  4: "Компьютеры", 5: "Телефоны и связь", 6: "Мебель и интерьер",
  7: "Продукты питания", 8: "Техника в быту", 9: "Одежда, обувь и др.",
  10: "Строительство", 11: "Нематериальные", 164: "Животные и растения",
  167: "Право аренды и услуги",
};

function resolveRegion(raw) {
  if (!raw && raw !== 0) return "";
  // Числовой ID
  const num = parseInt(raw);
  if (!isNaN(num) && REGION_ID_MAP[num]) return REGION_ID_MAP[num];
  // Строковое название (fallback)
  const lower = String(raw).toLowerCase();
  const aliases = {
    "брестская": "Брестская", "витебская": "Витебская",
    "гомельская": "Гомельская", "гродненская": "Гродненская",
    "минская": "Минская", "могилёвская": "Могилёвская",
    "могилевская": "Могилёвская", "г. минск": "Минск", "минск": "Минск",
  };
  for (const [key, val] of Object.entries(aliases)) {
    if (lower.includes(key)) return val;
  }
  return String(raw);
}

function resolveCategory(catId, slug) {
  // Сначала пробуем по числовому ID (если ID верхней категории)
  const num = parseInt(catId);
  if (!isNaN(num) && CATEGORY_ID_MAP[num]) return CATEGORY_ID_MAP[num];
  // Если ID подкатегории — используем slug верхней категории как подсказку
  if (slug) {
    const slugLabels = {
      "nedvizhimost": "Недвижимость",
      "transport-i-zapchasti": "Транспорт и запчасти",
      "oborudovanie": "Оборудование",
      "komp-yutery": "Компьютеры",
      "telefony-i-svyaz": "Телефоны и связь",
      "mebel-i-inter-er": "Мебель и интерьер",
      "produkty-pitaniya": "Продукты питания",
      "tehnika-v-bytu": "Техника в быту",
      "odezhda-obuv-i-dr": "Одежда, обувь и др.",
      "stroitel-stvo": "Строительство",
      "nematerial-nye": "Нематериальные",
      "pravo-arendy-i-uslugi": "Право аренды и услуги",
      "zhivotnye-i-rasteniya": "Животные и растения",
    };
    if (slugLabels[slug]) return slugLabels[slug];
  }
  return "";
}

// ── Матчинг подписки ───────────────────────────────────────

function matchLot(lot, sub) {
  if (!sub.source) return false;
  if (sub.source === "multi") {
    if (!(sub.sources || []).includes("torgigov")) return false;
  } else if (sub.source !== "torgigov") {
    return false;
  }

  // Категории — ОТКЛЮЧЕНО (бот больше не собирает sub.categories)

  const lotLocationText = resolveRegion(lot.region) + " " + (lot.location || "");
  if (!matchRegion(sub.region, lotLocationText, sub.regionKeywords, sub)) return false;

  const text = [lot.title, lot.category, lot.location].join(" ").toLowerCase();
  if (!matchKeywords(text, sub.keywords)) return false;

  if (sub.max_price > 0) {
    const raw = (lot.price || "").replace(/\s/g, "").replace(",", ".").replace("BYN","").trim();
    const num = parseFloat(raw);
    if (!isNaN(num) && num > sub.max_price) return false;
  }

  return true;
}

function formatLotMessage(lot) {
  const region   = resolveRegion(lot.region);
  const category = resolveCategory(lot.category, lot.slug);
  let msg = `🏛 <a href="${lot.url}">${escapeHtml(lot.title)}</a>`;
  if (lot.price)    msg += `\n💰 ${escapeHtml(lot.price)}`;
  if (region)       msg += `\n📍 ${escapeHtml(region)}`;
  if (lot.location) msg += ` — ${escapeHtml(lot.location)}`;
  if (category)     msg += `\n🏷 ${escapeHtml(category)}`;
  return msg;
}

// ════════════════════════════════════════════════════════════
// HANDLERS
// ════════════════════════════════════════════════════════════

// GET /api-lots?category=1&page=0&pagesize=50&...
async function handleApiLots(request) {
  const inUrl    = new URL(request.url);
  const pagesize = parseInt(inUrl.searchParams.get("pagesize") || "50");

  // Берём параметры напрямую из входящего запроса, добавляем только обязательные дефолты
  const params = new URLSearchParams({
    onlyNotActive: "false",
    history:       "false",
    sort1:         "approvetime",
  });
  // Параметры от парсера перезаписывают дефолты
  for (const [k, v] of inUrl.searchParams) {
    params.set(k, v);
  }

  const apiUrl = `${TORGI_API}/lots?${params.toString()}`;

  try {
    const resp = await fetch(apiUrl, { headers: API_HEADERS, cf: { cacheTtl: 0 } });
    const text = await resp.text();

    let data;
    try { data = JSON.parse(text); }
    catch { return jsonResponse({ ok: false, error: "non-JSON response", body: text.slice(0, 200), apiUrl }); }

    // Реальная структура: {"status":200,"result":{"lots":[...],"count":N}}
    const result     = data?.result ?? {};
    const lots       = result?.lots ?? [];
    const count      = result?.totCnt ?? result?.count ?? lots.length;
    const totalPages = Math.max(1, Math.ceil(count / pagesize));

    // Логируем для диагностики
    console.log(`api-lots: apiUrl=${apiUrl} status=${resp.status} count=${count}`);

    if (lots.length === 0) {
      // Пустой результат — добавляем диагностику прямо в ответ, чтобы парсер
      // мог сразу увидеть причину без отдельного похода в /debug-api
      return jsonResponse({
        lots: [], count: 0, totalPages: 1,
        _debug_apiUrl:    apiUrl,
        _debug_apiStatus: resp.status,
        _debug_rawBody:   text.slice(0, 500),
        _debug_dataKeys:  Object.keys(data || {}),
      });
    }

    return jsonResponse({ lots, count, totalPages, _debug_apiUrl: apiUrl, _debug_apiStatus: resp.status });
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e.message), apiUrl }, 502);
  }
}

// GET /debug-api
async function handleDebugApi() {
  const results = [];

  // Тест 1: точный URL который уйдёт в api/lots для category=1
  const params = new URLSearchParams({
    onlyNotActive: "false", history: "false", sort1: "approvetime",
    category: "1", page: "0", pagesize: "2",
  });
  const apiUrl = `${TORGI_API}/lots?${params.toString()}`;

  try {
    const resp = await fetch(apiUrl, { headers: API_HEADERS, cf: { cacheTtl: 0 } });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    results.push({
      test:       "api_lots_category1",
      apiUrl,
      httpStatus: resp.status,
      rawBody:    text.slice(0, 600),
      resultKeys: parsed?.result ? Object.keys(parsed.result) : null,
      lotsCount:  parsed?.result?.lots?.length ?? parsed?.lots?.length ?? null,
      totalCount: parsed?.result?.totCnt ?? parsed?.result?.count ?? null,
    });
  } catch (e) {
    results.push({ test: "api_lots_category1", apiUrl, error: e.message });
  }

  // Тест 2: без category — все лоты
  const apiUrl2 = `${TORGI_API}/lots?page=0&pagesize=2&onlyNotActive=false&history=false`;
  try {
    const resp2 = await fetch(apiUrl2, { headers: API_HEADERS, cf: { cacheTtl: 0 } });
    const text2 = await resp2.text();
    results.push({ test: "api_lots_all", apiUrl: apiUrl2, httpStatus: resp2.status, rawBody: text2.slice(0, 300) });
  } catch (e) {
    results.push({ test: "api_lots_all", error: e.message });
  }

  return jsonResponse({ results });
}
// Проксирует fetch() к torgi.gov.by для SSR-страниц (главная, страница лота)
const ALLOWED_HOSTS = ["torgi.gov.by", "api.torgi.gov.by"];

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
  const raw = await env.TORGIGOV_STORAGE.get("known_lots");
  return jsonResponse(raw ? JSON.parse(raw) : []);
}

// GET /categories
async function handleGetCategories(env) {
  const raw = await env.TORGIGOV_STORAGE.get("categories");
  return jsonResponse(raw ? JSON.parse(raw) : []);
}

// GET /status
async function handleGetStatus(env) {
  const [last_full_reset, snapshot_ts, last_daily_run] = await Promise.all([
    env.TORGIGOV_STORAGE.get("last_full_reset"),
    env.TORGIGOV_STORAGE.get("snapshot_timestamp"),
    env.TORGIGOV_STORAGE.get("last_daily_run"),
  ]);
  return jsonResponse({ last_full_reset, snapshot_ts, last_daily_run, current_time: new Date().toISOString() });
}

// POST /save-daily-run {date, lots_found}
async function handleSaveDailyRun(body, env) {
  const ts = new Date().toISOString();
  await env.TORGIGOV_STORAGE.put("last_daily_run", JSON.stringify({
    ts,
    date:       body.date       ?? ts.slice(0, 10),
    lots_found: body.lots_found ?? 0,
    categories: body.categories ?? [],
  }));
  return jsonResponse({ ok: true, ts });
}

// POST /snapshot  {snapshot: [lotId, ...]}
async function handleSnapshot(body, env) {
  const ids = (body.snapshot || []).map(String);
  await env.TORGIGOV_STORAGE.put("known_lots", JSON.stringify(ids.slice(0, MAX_KNOWN_LOTS)));
  const ts = new Date().toISOString();
  await env.TORGIGOV_STORAGE.put("snapshot_timestamp", ts);
  await env.TORGIGOV_STORAGE.put("last_full_reset", ts);
  return jsonResponse({ ok: true, ts, count: ids.length });
}

// POST /save-categories  {categories: [...]}
async function handleSaveCategories(body, env) {
  const { categories } = body;
  if (!Array.isArray(categories)) return new Response("Bad categories", { status: 400 });
  await env.TORGIGOV_STORAGE.put("categories", JSON.stringify(categories));
  return jsonResponse({ ok: true, count: categories.length });
}

// POST /add-lots  {lot_ids: [...]}
async function handleAddLots(body, env) {
  const { lot_ids } = body;
  if (!Array.isArray(lot_ids)) return new Response("Bad request", { status: 400 });

  const raw      = await env.TORGIGOV_STORAGE.get("known_lots");
  const existing = raw ? JSON.parse(raw) : [];
  const existingSet = new Set(existing);
  const newIds   = lot_ids.map(String).filter(id => !existingSet.has(id));

  const combined = [...newIds, ...existing].slice(0, MAX_KNOWN_LOTS);
  await env.TORGIGOV_STORAGE.put("known_lots", JSON.stringify(combined));
  return jsonResponse({ ok: true, added: newIds.length, total: combined.length });
}

// POST /save-daily-lots  {date, lots: [...], ttl}
async function handleSaveDailyLots(body, env) {
  const { date, lots, ttl } = body;
  if (!date || !Array.isArray(lots)) return new Response("Bad request", { status: 400 });
  await env.TORGIGOV_STORAGE.put(
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

  const lotsRaw = await env.TORGIGOV_STORAGE.get(`daily_lots:${date}`);
  if (!lotsRaw) return jsonResponse({ ok: true, sent: 0, reason: "no lots" });

  const lots  = JSON.parse(lotsRaw);
  const items = lots.map(lot => ({
    text:    formatLotMessage(lot),
    matchFn: sub => matchLot(lot, sub),
  }));

  const sent = await sendNotifications(items, env.SUBSCRIBERS, env.BOT_TOKEN);
  return jsonResponse({ ok: true, sent });
}

// ── Fetch handler ──────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      if (!checkAuth(request, env)) return new Response("Unauthorized", { status: 401 });

      const url    = new URL(request.url);
      const path   = url.pathname;
      const method = request.method;

      // GET endpoints
      if (method === "GET" && path === "/known-lots")  return handleGetKnownLots(env);
      if (method === "GET" && path === "/categories")  return handleGetCategories(env);
      if (method === "GET" && path === "/status")      return handleGetStatus(env);
      if (method === "GET" && path === "/api-lots")    return handleApiLots(request);
      if (method === "GET" && path === "/debug-api")   return handleDebugApi();

      // POST endpoints
      const body = await request.json().catch(() => null);
      if (!body) return new Response("Bad JSON", { status: 400 });

      if (method === "POST" && path === "/snapshot")           return handleSnapshot(body, env);
      if (method === "POST" && path === "/save-categories")    return handleSaveCategories(body, env);
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
