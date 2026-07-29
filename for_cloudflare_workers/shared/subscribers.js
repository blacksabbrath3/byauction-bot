import { tgSend, sendPhoto } from "./telegram.js";

const CAPTION_LIMIT = 1024; // лимит Telegram для caption у фото (у текста sendMessage — 4096)

/**
 * Отправляет одно уведомление о лоте. Если item.photo указан, шлёт фото
 * с подписью (caption); если фото не влезает в лимит подписи, шлёт фото
 * с обрезанной подписью и полный текст следующим сообщением. Если Telegram
 * не смог отправить фото (битая ссылка, сайт недоступен ему и т.п.) —
 * откатываемся на обычное текстовое сообщение, чтобы уведомление не потерялось.
 */
async function sendLotNotification(token, chatId, item) {
  if (item.photo) {
    const fits = item.text.length <= CAPTION_LIMIT;
    const result = await sendPhoto(
      token, chatId, item.photo,
      fits ? item.text : item.text.slice(0, CAPTION_LIMIT - 1) + "…",
    );
    if (result?.ok) {
      if (!fits) await tgSend(token, chatId, item.text);
      return;
    }
    console.warn("sendPhoto failed, falling back to text:", result?.description);
  }
  await tgSend(token, chatId, item.text);
}

export async function getSubscriberList(SUBSCRIBERS) {
  const list = await SUBSCRIBERS.list({ prefix: "sub:" });
  const result = [];
  for (const key of list.keys) {
    const raw = await SUBSCRIBERS.get(key.name);
    if (!raw) continue;
    result.push({ userId: key.name.slice(4), subs: JSON.parse(raw) });
  }
  return result;
}

/**
 * Рассылает уведомления подходящим подписчикам.
 * @param items        - массив объектов { text, photo?, matchFn(sub) } — photo необязателен,
 *   при наличии шлётся как sendPhoto с подписью (откат на текст при неудаче)
 * @param SUBSCRIBERS  - KV binding
 * @param BOT_TOKEN    - секрет
 * @returns {{sent: number, perUser: Object<string, Object<string, {count: number, sub: object}>>}}
 *   perUser: userId → subId → { count, sub } — используется для дневного дайджеста админам.
 */
export async function sendNotifications(items, SUBSCRIBERS, BOT_TOKEN) {
  const subscribers = await getSubscriberList(SUBSCRIBERS);
  let sent = 0;
  const perUser = {};

  for (const { userId, subs } of subscribers) {
    for (const item of items) {
      for (const sub of subs) {
        if (item.matchFn(sub)) {
          await sendLotNotification(BOT_TOKEN, userId, item);
          sent++;

          const subId = sub.id || "unknown";
          perUser[userId] ??= {};
          if (!perUser[userId][subId]) perUser[userId][subId] = { count: 0, sub };
          perUser[userId][subId].count++;

          break; // один лот — одно уведомление
        }
      }
    }
  }
  return { sent, perUser };
}
