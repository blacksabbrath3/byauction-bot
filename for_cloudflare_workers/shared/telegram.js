export async function tgCall(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export const sendMessage = (token, chatId, text, extra = {}) =>
  tgCall(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });

export const editMessage = (token, chatId, messageId, text, extra = {}) =>
  tgCall(token, "editMessageText",
    { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });

export const answerCallback = (token, callbackId, text = "") =>
  tgCall(token, "answerCallbackQuery", { callback_query_id: callbackId, text });

export const deleteMessage = (token, chatId, messageId) =>
  tgCall(token, "deleteMessage", { chat_id: chatId, message_id: messageId });

const IMAGE_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sendPhotoByUrl = (token, chatId, photo, caption, extra = {}) =>
  tgCall(token, "sendPhoto", {
    chat_id: chatId, photo, caption, parse_mode: "HTML", ...extra,
  });

/**
 * Отправляет фото. Сначала — обычным способом, передав Telegram ссылку
 * (дёшево, без лишнего трафика на воркере). Если Telegram сам не смог
 * скачать картинку («Bad Request: failed to get HTTP URL content» — так
 * бывает, если сайт блокирует запрос от Telegram по User-Agent/защите от
 * хотлинков, как оказалось у gostorg.by), скачиваем картинку сами и
 * отправляем в Telegram уже как файл (multipart) — это обходит блокировку
 * на стороне сайта, раз сам воркер туда достучаться может.
 */
export async function sendPhoto(token, chatId, photoUrl, caption, extra = {}) {
  const byUrl = await sendPhotoByUrl(token, chatId, photoUrl, caption, extra);
  if (byUrl?.ok) return byUrl;

  try {
    const imgResp = await fetch(photoUrl, { headers: { "User-Agent": IMAGE_FETCH_UA } });
    if (!imgResp.ok) return byUrl; // и сами не смогли — возвращаем исходную ошибку

    const blob = await imgResp.blob();
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    form.append("parse_mode", "HTML");
    for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
    form.append("photo", blob, "photo.jpg");

    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST", body: form,
    });
    return await r.json();
  } catch (e) {
    console.warn("sendPhoto fallback (скачать+загрузить) не удался:", e.message);
    return byUrl;
  }
}

export async function tgSend(token, chatId, text) {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}
