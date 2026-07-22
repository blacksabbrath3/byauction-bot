// ============================================================
// workers/rechitsa/index.js — API для парсера rechitsa.by
// 
// Источник: https://rechitsa.by/ru/lenta_novostei-ru/ (новостная лента)
// Парсер собирает заголовки + тексты новостей, воркер рассылает
// подписчикам те новости, в которых найдены их ключевые слова.
//
// Bindings:
//   KV:      RECHITSA_STORAGE → rechitsa_storage
//            SUBSCRIBERS      → bot_subscribers
//   Secrets: BOT_TOKEN, PARSER_SECRET
// ============================================================

import { matchKeywords }                        from "../../shared/matchKeyword.js";
import { sendNotifications }                    from "../../shared/subscribers.js";
import { escapeHtml, jsonResponse, checkAuth }  from "../../shared/format.js";
import { recordDigest }                         from "../../shared/digest.js";

// Достаточно помнить последние 50 известных новостей
const MAX_KNOWN_ARTICLES = 50;

// ── Матчинг ───────────────────────────────────────────────────

function matchArticle(article, sub) {
  if (sub.source === "multi") {
    if (!(sub.sources || []).includes("rechitsa")) return false;
  } else if (sub.source !== "rechitsa") {
    return false;
  }

  const text = [article.title, article.full_text || article.excerpt]
    .join(" ").toLowerCase();

  return matchKeywords(text, sub.keywords);
}

// ── Форматирование ────────────────────────────────────────────

function formatArticleMessage(article) {
  let msg = `📋 <a href="${article.url}">${escapeHtml(article.title)}</a>`;
  if (article.date)    msg += `\n📅 ${escapeHtml(article.date)}`;
  if (article.excerpt) msg += `\n\n${escapeHtml(article.excerpt)}`;
  return msg;
}

// ── Handlers ──────────────────────────────────────────────────

async function handleGetStatus(env) {
  const raw = await env.RECHITSA_STORAGE.get("last_daily_run");
  return jsonResponse({
    last_daily_run: raw ? JSON.parse(raw) : null,
    current_time:   new Date().toISOString(),
  });
}

async function handleSaveDailyRun(body, env) {
  const ts = new Date().toISOString();
  await env.RECHITSA_STORAGE.put("last_daily_run", JSON.stringify({
    ts,
    date:       body.date       ?? ts.slice(0, 10),
    lots_found: body.lots_found ?? 0,
  }));
  return jsonResponse({ ok: true, ts });
}

async function handleGetKnownArticles(env) {
  const raw = await env.RECHITSA_STORAGE.get("known_articles");
  return jsonResponse({ articles: raw ? JSON.parse(raw) : [] });
}

async function handleAddArticles(body, env) {
  const { urls } = body;
  if (!Array.isArray(urls)) return new Response("Bad request", { status: 400 });

  const raw      = await env.RECHITSA_STORAGE.get("known_articles");
  const existing = new Set(raw ? JSON.parse(raw) : []);
  const newOnes  = urls.filter(u => !existing.has(u));
  const merged   = [...newOnes, ...existing].slice(0, MAX_KNOWN_ARTICLES);

  await env.RECHITSA_STORAGE.put("known_articles", JSON.stringify(merged));
  return jsonResponse({ ok: true, added: newOnes.length, total: merged.length });
}

async function handleSaveDailyArticles(body, env) {
  const { date, articles, ttl } = body;
  if (!date || !Array.isArray(articles)) return new Response("Bad request", { status: 400 });

  await env.RECHITSA_STORAGE.put(
    `daily_articles:${date}`,
    JSON.stringify(articles),
    { expirationTtl: ttl || 86400 }
  );
  return jsonResponse({ ok: true, count: articles.length });
}

async function handleSendNotifications(body, env) {
  const { date } = body;
  if (!date) return new Response("Missing date", { status: 400 });

  const raw = await env.RECHITSA_STORAGE.get(`daily_articles:${date}`);
  if (!raw) {
    await recordDigest(env, { source: "rechitsa", newLots: 0, perUser: {}, date });
    return jsonResponse({ ok: true, sent: 0, reason: "no articles" });
  }

  const articles = JSON.parse(raw);
  const items    = articles.map(article => ({
    text:    formatArticleMessage(article),
    matchFn: sub => matchArticle(article, sub),
  }));

  const { sent, perUser } = await sendNotifications(items, env.SUBSCRIBERS, env.BOT_TOKEN);

  await recordDigest(env, { source: "rechitsa", newLots: articles.length, perUser, date });

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

      if (method === "GET"  && path === "/status")             return handleGetStatus(env);
      if (method === "GET"  && path === "/known-articles")      return handleGetKnownArticles(env);

      const body = await request.json().catch(() => null);
      if (!body) return new Response("Bad JSON", { status: 400 });

      if (method === "POST" && path === "/add-articles")        return handleAddArticles(body, env);
      if (method === "POST" && path === "/save-daily-articles") return handleSaveDailyArticles(body, env);
      if (method === "POST" && path === "/save-daily-run")      return handleSaveDailyRun(body, env);
      if (method === "POST" && path === "/send-notifications")  return handleSendNotifications(body, env);

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error("CRASH:", e.message, e.stack);
      return new Response("Internal Error", { status: 500 });
    }
  },
};
