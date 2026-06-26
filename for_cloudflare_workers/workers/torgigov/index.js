// ============================================================
// workers/torgigov/index.js
//
// Bindings:
//   KV:      TORGIGOV_STORAGE, SUBSCRIBERS
//   Secrets: BOT_TOKEN, PARSER_SECRET
//
// Endpoints:
//   GET  /known-lots           → [lotId, ...]
//   GET  /status               → {last_full_reset, snapshot_ts}
//   POST /snapshot             → {snapshot: [lotId, ...]}
//   POST /add-lots             → {lot_ids: [...]}
//   POST /save-daily-lots      → {date, lots: [...], ttl}
//   POST /send-notifications   → {date}
//   POST /fetch-page           → {url} → {ok, status, html}
//       Для парсинга главной страницы и страниц лотов (SSR).
//   GET  /api-lots?page=0&pagesize=9&sort=start&state=15,16,4,5,18,19,20,21,22,23
//       Проксирует GET к api.torgi.gov.by/api/lots — недоступен с GitHub IP.
//       Список без категорий (как "Недавно добавленные" на главной) —
//       подтверждённый рабочий запрос снят через DevTools с реального сайта.
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

// ── Категории ────────────────────────────────────────────────

// Числовые ID категорий torgi.gov.by → человекочитаемые названия.
// Синхронизировано с torgigov_lib.CATEGORIES (Python-парсер).
const CATEGORY_ID_MAP = {
  13: "Здания производственного назначения",
  14: "Здания офисного назначения",
  15: "Дома, коттеджи", 16: "Павильоны, нестационарные конструкции",
  17: "Квартиры", 18: "Земельные участки",
  19: "Гаражи, парковки, машиноместо",
  20: "Грузовой транспорт", 22: "Легковые машины",
  23: "Прицепы", 24: "Мотоциклы", 26: "Иной легковой транспорт",
  27: "Запчасти к грузовому транспорту", 28: "Запчасти к легковому транспорту",
  29: "Шины, колеса, диски", 30: "Автоинструмент", 31: "Автоэлектроника",
  32: "Оборудование для ремонта", 33: "Офисное оборудование",
  34: "Производственное оборудование", 35: "Торговое оборудование",
  36: "Бытовое назначение", 37: "Машины и механизмы",
  38: "Отопление водоснабжение", 39: "Заборы, ограждения",
  40: "Компьютеры", 44: "Программное обеспечение",
  45: "Сетевое оборудование", 46: "Мобильные телефоны",
  47: "Стационарные телефоны", 49: "Факсы", 50: "Радиостанции",
  51: "Мебель", 52: "Мебель в ванную", 53: "Люстры и светильники",
  54: "Посуда", 55: "Товары хозяйственного назначения",
  56: "Зоотовары", 57: "Крупы, мука", 58: "Кофе, чай",
  59: "Табачные изделия", 60: "Телевизоры", 61: "Холодильники",
  62: "Стиральные машины", 63: "Посудомоечные машины",
  64: "Микроволновые печи", 65: "Бытовая техника",
  66: "Домашний текстиль", 67: "Женская одежда", 68: "Женская обувь",
  69: "Мужская одежда", 70: "Мужская обувь",
  71: "Детская одежда", 72: "Детская обувь", 73: "Детские товары",
  74: "Украшения", 75: "Часы", 76: "Аксессуары", 77: "Головные уборы",
  78: "Спорттовары", 79: "Инструмент",
  80: "Стройматериалы", 81: "Строительное оборудование",
  82: "Сантехника", 83: "Садовая техника", 84: "Растения",
  86: "Интеллектуальная собственность", 87: "Дебиторская задолженность",
  96: "Игровые", 102: "Игровые приставки",
  103: "Овощи и фрукты", 105: "Заморозка", 106: "Хлебобулочные",
  107: "Напитки", 108: "Продукты животного происх.", 109: "Продукты растит. происх.",
  110: "Овощи", 111: "Фрукты", 112: "Свинина", 113: "Говядина",
  114: "Курица", 115: "Мясо", 116: "Продукты", 117: "Охлаждённые продукты",
  118: "Глубокая заморозка", 119: "Кухонные плиты", 120: "Пылесосы",
  121: "Кофе", 122: "Чай", 123: "Электрика", 124: "Двери, окна",
  128: "Аксессуары для телефонов", 129: "Аккумуляторы",
  130: "Чехлы", 131: "Зарядные устройства", 132: "Карты памяти",
  133: "Аксессуары", 134: "Телефоны DECT", 135: "Проводные телефоны",
  136: "Товарные знаки", 137: "Доли в уставном фонде",
  139: "Водный транспорт", 140: "Воздушный транспорт",
  141: "Сельхозтехника", 142: "Тракторы",
  143: "Обработка почвы", 144: "Посев и посадка", 145: "Уход за культурами",
  146: "Сбор зерновых", 147: "Сбор кормов", 148: "Сбор овощей",
  149: "Сбор культур", 150: "Послеуборочная обработка",
  151: "Животноводство", 152: "Минитехника",
  153: "Запчасти к сельхозтехнике", 154: "Спецтехника",
  155: "Мини АТС", 158: "Спецпрограммы",
  159: "Интернет-сайты", 160: "Операционные системы",
  161: "Видео-фотоматериалы", 162: "Имущественный комплекс",
  163: "Право аренды", 165: "Упаковка и тара",
  166: "Сырьё и материалы", 168: "Недвижимость",
  170: "Транспорт", 171: "Оборудование", 172: "Спецтехника",
  174: "Услуги", 175: "Медтехника и ветеринария",
};

// Категории которые лучше не показывать — слишком общие/неинформативные
const UNINFORMATIVE_CATEGORIES = new Set([156, 165, 116, 133, 76]);

function resolveCategory(catId) {
  if (!catId && catId !== 0) return "";
  const id = parseInt(catId);
  if (UNINFORMATIVE_CATEGORIES.has(id)) return "";
  return CATEGORY_ID_MAP[id] || "";
}

// ── Регионы ────────────────────────────────────────────────

// Числовые ID регионов из API torgi.gov.by
const REGION_ID_MAP = {
  1: "Брестская", 2: "Витебская", 3: "Гомельская",
  4: "Гродненская", 5: "Минская", 6: "Могилёвская",
  7: "Брестская", 8: "Витебская", 9: "Гомельская",
  10: "Гродненская", 11: "Минская", 12: "Могилёвская",
  13: "Минск",
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

  const text = [lot.title, resolveCategory(lot.category), lot.location, lot.description].join(" ").toLowerCase();
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
  const category = resolveCategory(lot.category);
  let msg = `🏛 <a href="${lot.url}">${escapeHtml(lot.title)}</a>`;
  if (lot.auction_start) msg += `\n📅 Старт: ${escapeHtml(lot.auction_start)}`;
  if (lot.price)         msg += `\n💰 ${escapeHtml(lot.price)}`;
  if (region)            msg += `\n📍 ${escapeHtml(region)}`;
  if (lot.location)      msg += ` — ${escapeHtml(lot.location)}`;
  if (category)          msg += `\n🏷 ${escapeHtml(category)}`;
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

// GET /api-lots?page=1&pagesize=9&sort=start&state=15,16,4,5,18,19,20,21,22,23
async function handleApiLots(request) {
  const inUrl    = new URL(request.url);
  const pagesize = parseInt(inUrl.searchParams.get("pagesize") || "9");

  // ВАЖНО: подтверждённый рабочий запрос с сайта (через DevTools) — ТОЧНО:
  //   page=1&pagesize=9&sort=start&state=15,16,4,5,18,19,20,21,22,23
  // API чувствителен к pagesize — другие значения (5, 50) дают
  // {"status":400,"message":"Request failed: "} при HTTP 200.
  // category НЕ поддерживается как фильтр здесь — это поле внутри лота.
  const defaults = {
    sort:  "start",
    state: "15,16,4,5,18,19,20,21,22,23",
  };
  const params = new URLSearchParams();
  // Сохраняем порядок: сначала дефолты (если не переопределены), потом входящие
  for (const [k, v] of Object.entries(defaults)) {
    if (!inUrl.searchParams.has(k)) params.set(k, v);
  }
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

// GET /debug-api — диагностика подтверждённым рабочим запросом
async function handleDebugApi() {
  const params = new URLSearchParams({
    page: "0", pagesize: "9",
    sort: "start", state: "15,16,4,5,18,19,20,21,22,23",
  });
  const apiUrl = `${TORGI_API}/lots?${params.toString()}`;

  try {
    const resp = await fetch(apiUrl, { headers: API_HEADERS, cf: { cacheTtl: 0 } });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const lots     = parsed?.result?.lots ?? [];
    const firstLot = lots[0] ?? null;
    return jsonResponse({
      apiUrl,
      httpStatus:    resp.status,
      lotsCount:     lots.length,
      totalCount:    parsed?.result?.totCnt ?? null,
      // Полный объект первого лота — чтобы увидеть все доступные поля API
      firstLotKeys:  firstLot ? Object.keys(firstLot) : null,
      firstLotRaw:   firstLot,
    });
  } catch (e) {
    return jsonResponse({ apiUrl, error: e.message }, 502);
  }
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
      const url    = new URL(request.url);
      const path   = url.pathname;
      const method = request.method;

      // /debug-api публичен — только чтение, меняет данные, удобен для диагностики из браузера
      if (method === "GET" && path === "/debug-api") return handleDebugApi();

      if (!checkAuth(request, env)) return new Response("Unauthorized", { status: 401 });

      // GET endpoints
      if (method === "GET" && path === "/known-lots")  return handleGetKnownLots(env);
      if (method === "GET" && path === "/status")      return handleGetStatus(env);
      if (method === "GET" && path === "/api-lots")    return handleApiLots(request);

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
