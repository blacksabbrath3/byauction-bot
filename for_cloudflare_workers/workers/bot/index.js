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

// ── Промокоды ─────────────────────────────────────────────────

function isAdmin(env, userId) {
  const admins = (env.ADMIN_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return admins.includes(userId);
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
};
