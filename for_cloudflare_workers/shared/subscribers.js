import { tgSend } from "./telegram.js";

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
 * @param items        - массив объектов { text, matchFn(sub) }
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
          await tgSend(BOT_TOKEN, userId, item.text);
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
