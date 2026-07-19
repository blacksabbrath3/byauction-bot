/**
 * bot/index.js — Точка входа. Только маршрутизация Telegram-обновлений.
 * 
 * Вся логика вынесена в модули:
 *   kv.js       — KV-хранилище (подписки, диалоги, категории)
 *   keywords.js — Парсинг ключевых слов
 *   keyboards.js — Inline-клавиатуры
 *   steps.js    — Тексты шагов, subSummary, helpText
 *   dialog.js   — Диалог подписки (handleCallback, handleTextInDialog, finishSubscription)
 */

import { tgCall, sendMessage } from "../../shared/telegram.js";
import { saveSubs, redeemPromoCode, createPromoCode } from "./kv.js";
import { mainReplyKeyboard } from "./keyboards.js";
import { helpText } from "./steps.js";
import {
  startSubscribeDialog, handleCallback,
  handleTextInDialog, sendListMessage,
  getMaxSubs, BASE_MAX_SUBS,
} from "./dialog.js";
import { getDigest, saveDigest, todayDateUTC } from "../../shared/digest.js";

// ── Дневной дайджест для админов ────────────────────────────────

const DIGEST_SOURCE_LABELS = {
  eauction: "🏛 e-auction.by",
  torgigov: "🏦 torgi.gov.by",
  butb:     "🏗 БУТБ (et.butb.by)",
  rechitsa: "🏙 Речицкий райисполком",
};

/** Разбивает длинный текст на куски ≤ maxLen символов, не разрывая строки. */
function chunkText(text, maxLen = 3500) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatSourcesBlock(digest) {
  const sourceEntries = Object.entries(digest.sources || {});
  if (!sourceEntries.length) {
    return "За сегодня новых лотов не найдено ни на одном сайте.";
  }

  const lines = [];
  let totalNew = 0, totalSent = 0;

  for (const [source, stats] of sourceEntries) {
    const label = DIGEST_SOURCE_LABELS[source] || source;
    lines.push(`${label}: <b>${stats.newLots}</b> нов., отправлено ${stats.sent}`);
    totalNew  += stats.newLots || 0;
    totalSent += stats.sent    || 0;

    const cats = Object.entries(stats.categories || {}).sort((a, b) => b[1] - a[1]);
    for (const [catLabel, count] of cats) {
      lines.push(`   • ${catLabel}: ${count}`);
    }
    lines.push("");
  }

  lines.push(`Итого новых лотов: <b>${totalNew}</b>`);
  lines.push(`Итого отправлено уведомлений: <b>${totalSent}</b>`);
  return lines.join("\n");
}

/** Пытается получить имя пользователя через getChat; при неудаче — просто id. */
async function fetchDisplayName(token, userId) {
  try {
    const r = await tgCall(token, "getChat", { chat_id: userId });
    if (r?.ok && r.result) {
      const { first_name, last_name, username } = r.result;
      const name = [first_name, last_name].filter(Boolean).join(" ");
      if (name) return name;
      if (username) return `@${username}`;
    }
  } catch (e) {
    console.warn("getChat failed for", userId, e.message);
  }
  return `id ${userId}`;
}

async function formatUsersBlock(token, digest) {
  const entries = Object.entries(digest.users || {});
  if (!entries.length) return "Уведомления сегодня не отправлялись.";

  const lines = [];
  for (const [userId, subCounts] of entries) {
    const name = await fetchDisplayName(token, userId);
    lines.push(`<b>${name}</b> (id ${userId}):`);
    for (const { label, count } of Object.values(subCounts)) {
      lines.push(`  • ${label}: ${count}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Формирует и рассылает дневной дайджест всем ADMIN_IDS. */
async function sendDailyDigest(env, { date, force = false } = {}) {
  const d = date || todayDateUTC();
  const admins = getAdminIds(env);
  if (!admins.length) return { ok: false, reason: "no_admins" };

  const digest = await getDigest(env, d);
  if (digest.notifiedAt && !force) return { ok: false, reason: "already_sent" };

  const sourcesText = formatSourcesBlock(digest);
  const usersText   = await formatUsersBlock(env.BOT_TOKEN, digest);

  const summaryMsg = `📊 <b>Дневной дайджест — ${d}</b>\n\n${sourcesText}`;
  const usersMsg   = `👥 <b>Кому отправлены лоты — ${d}</b>\n\n${usersText}`;

  for (const adminId of admins) {
    for (const chunk of chunkText(summaryMsg)) {
      await sendMessage(env.BOT_TOKEN, adminId, chunk);
    }
    for (const chunk of chunkText(usersMsg)) {
      await sendMessage(env.BOT_TOKEN, adminId, chunk);
    }
  }

  digest.notifiedAt = Date.now();
  await saveDigest(env, d, digest);
  return { ok: true };
}

function isAdmin(env, userId) {
  const admins = (env.ADMIN_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return admins.includes(userId);
}

function getAdminIds(env) {
  return (env.ADMIN_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

async function handlePromoCommand(token, chatId, userId, text, env) {
  const code = text.split(/\s+/)[1];
  if (!code) {
    return sendMessage(token, chatId,
      "ℹ️ Использование: <code>/promo КОД</code>\n\n" +
      "Введите промокод, полученный от администратора, чтобы получить дополнительные подписки.");
  }

  const result = await redeemPromoCode(env, userId, code);
  if (!result.ok) {
    const msg = result.reason === "used"
      ? "⚠️ Этот промокод уже был использован."
      : "⚠️ Промокод не найден. Проверьте правильность ввода.";
    return sendMessage(token, chatId, msg);
  }

  const newLimit = await getMaxSubs(env, userId);
  return sendMessage(token, chatId,
    `✅ Промокод активирован!\n\n` +
    `Начислено дополнительных подписок: <b>${result.bonus}</b>.\n` +
    `Ваш новый лимит подписок: <b>${newLimit}</b>.`);
}

async function handleGencodeCommand(token, chatId, userId, text, env) {
  if (!isAdmin(env, userId)) return; // не выдаём себя обычным пользователям

  const arg = text.split(/\s+/)[1];
  const n = parseInt(arg, 10);
  if (!arg || isNaN(n) || n <= 0) {
    return sendMessage(token, chatId,
      "ℹ️ Использование: <code>/gencode количество</code>\n\n" +
      "Например: <code>/gencode 5</code> — создаст код на 5 доп. подписок.");
  }

  const code = await createPromoCode(env, n, userId);
  return sendMessage(token, chatId,
    `✅ Промокод создан:\n\n<code>${code}</code>\n\n` +
    `Даёт <b>${n}</b> доп. подпис${n === 1 ? "ку" : n < 5 ? "ки" : "ок"} ` +
    `(сверх базовых ${BASE_MAX_SUBS}).\n\n` +
    `Отправьте этот код пользователю — он активирует его командой:\n` +
    `<code>/promo ${code}</code>`);
}

// ── Bot commands ──────────────────────────────────────────────

async function setMyCommands(token) {
  await tgCall(token, "setMyCommands", {
    commands: [
      { command: "subscribe",       description: "➕ Создать подписку"     },
      { command: "list",            description: "📋 Мои подписки"          },
      { command: "promo",           description: "🎟 Активировать промокод" },
      { command: "unsubscribe_all", description: "🗑 Удалить все подписки"  },
      { command: "help",            description: "❓ Справка"               },
    ],
  });
  await tgCall(token, "setChatMenuButton", { menu_button: { type: "commands" } });
}

// ── Telegram update handler ───────────────────────────────────

async function handleTelegramUpdate(update, env) {
  const token = env.BOT_TOKEN;

  if (update.callback_query) return handleCallback(token, update, env);

  if (update.my_chat_member) {
    const status = update.my_chat_member.new_chat_member?.status;
    if (status === "member") {
      const chatId = update.my_chat_member.chat.id;
      await setMyCommands(token);
      return sendMessage(token, chatId, helpText(), { reply_markup: mainReplyKeyboard() });
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text   = msg.text.trim();

  if (text === "/start" || text === "/help" || text === "❓ Справка") {
    await setMyCommands(token);
    return sendMessage(token, chatId, helpText(), {
      reply_markup: mainReplyKeyboard(),
      disable_web_page_preview: true,
    });
  }

  if (text === "/subscribe" || text === "➕ Подписаться")
    return startSubscribeDialog(token, chatId, userId, env);

  if (text === "/list" || text === "📋 Мои подписки") {
    return sendListMessage(token, chatId, userId, env);
  }

  if (text === "/unsubscribe_all" || text === "🗑 Удалить все подписки") {
    await saveSubs(env, userId, []);
    return sendMessage(token, chatId, "✅ Все подписки удалены.");
  }

  if (text.startsWith("/promo")) {
    return handlePromoCommand(token, chatId, userId, text, env);
  }

  if (text.startsWith("/gencode")) {
    return handleGencodeCommand(token, chatId, userId, text, env);
  }

  if (text.startsWith("/digest")) {
    if (!isAdmin(env, userId)) return;
    const result = await sendDailyDigest(env, { force: true });
    if (!result.ok && result.reason === "no_admins") {
      return sendMessage(token, chatId, "⚠️ ADMIN_IDS не настроен.");
    }
    return; // sendDailyDigest сам отправляет сообщения админам
  }

  await handleTextInDialog(token, chatId, userId, text, env);
}

// ── Fetch handler ─────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/set-webhook") {
        const webhookUrl = `${url.origin}/webhook`;
        const params = new URLSearchParams({
          url: webhookUrl,
          allowed_updates: JSON.stringify(["message", "callback_query", "my_chat_member"]),
        });
        if (env.WEBHOOK_SECRET) params.set("secret_token", env.WEBHOOK_SECRET);
        const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?${params}`);
        const d = await r.json();
        return new Response(JSON.stringify({ webhookUrl, result: d }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/get-webhook-info") {
        const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
        const d = await r.json();
        return new Response(JSON.stringify(d, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
          return new Response("Forbidden", { status: 403 });
        }
        const update = await request.json();
        await handleTelegramUpdate(update, env);
        return new Response("OK");
      }

      return new Response("Bot Worker — OK");
    } catch (e) {
      console.error("CRASH:", e.message, e.stack);
      return new Response("OK");
    }
  },

  // Вызывается по расписанию из wrangler.toml ([triggers] crons = [...]).
  // Собирает дневной дайджест (новые лоты по сайтам + кому что разослано)
  // и отправляет его всем ADMIN_IDS.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      sendDailyDigest(env).catch(e => console.error("digest CRASH:", e.message, e.stack))
    );
  },
};
