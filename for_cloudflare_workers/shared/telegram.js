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
