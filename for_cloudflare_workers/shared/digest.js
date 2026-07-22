/**
 * shared/digest.js — Общий дневной дайджест для админов.
 *
 * Каждый воркер источника (butb/eauction/torgigov/rechitsa) после того как
 * разослал лоты подписчикам, дописывает свою статистику в `digest:<date>`
 * в KV SUBSCRIBERS — единственном KV-namespace, который есть у всех воркеров
 * (включая bot-worker). Раз в день bot-worker (по cron) читает этот ключ,
 * формирует сообщение и отправляет его всем ADMIN_IDS.
 */

const DIGEST_TTL = 9 * 24 * 3600; // 9 дней — с запасом покрывает недельную статистику (7 дней)

export function todayDateUTC() {
  return new Date().toISOString().slice(0, 10);
}

export async function getDigest(env, date) {
  const raw = await env.SUBSCRIBERS.get(`digest:${date}`);
  return raw ? JSON.parse(raw) : { date, sources: {}, users: {} };
}

export async function saveDigest(env, date, digest) {
  await env.SUBSCRIBERS.put(`digest:${date}`, JSON.stringify(digest), {
    expirationTtl: DIGEST_TTL,
  });
}

function mergeCounts(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/** Компактное (без HTML-разметки summary) описание подписки — для дайджеста. */
export function subLabel(sub) {
  if (!sub) return "подписка";
  const srcNames = {
    eauction: "e-auction.by",
    torgigov: "torgi.gov.by",
    butb:     "БУТБ",
    rechitsa: "Речицкий райисполком",
    gostorg:  "Госторг (gostorg.by)",
  };
  const name = sub.source === "multi"
    ? `Несколько сайтов (${(sub.sources || []).map(s => srcNames[s] || s).join(", ")})`
    : (srcNames[sub.source] || sub.source || "?");

  const kw = (sub.keywords || [])
    .flat()
    .map(w => (typeof w === "string" ? w : w.word))
    .filter(Boolean);
  const kwLabel = kw.length
    ? `ключевые слова: ${kw.slice(0, 4).join(", ")}${kw.length > 4 ? "…" : ""}`
    : "все уведомления";

  return `${name} — ${kwLabel}`;
}

/**
 * Записывает статистику одного источника за день в общий дайджест.
 *
 * @param env
 * @param source     - "eauction" | "torgigov" | "butb" | "rechitsa"
 * @param newLots    - сколько новых лотов/публикаций найдено всего за запуск
 * @param categories - необязательно, { "Название категории": count }
 * @param perUser    - { userId: { subId: { count, sub } } } — из sendNotifications
 * @param date       - YYYY-MM-DD, по умолчанию сегодня (UTC)
 */
export async function recordDigest(env, { source, newLots, categories, perUser, date }) {
  const d = date || todayDateUTC();
  const digest = await getDigest(env, d);

  const prevSrc = digest.sources[source] || { newLots: 0, sent: 0, categories: {} };
  let sentTotal = 0;
  for (const subCounts of Object.values(perUser || {})) {
    for (const { count } of Object.values(subCounts)) sentTotal += count;
  }

  digest.sources[source] = {
    newLots:    (prevSrc.newLots || 0) + (newLots || 0),
    sent:       (prevSrc.sent    || 0) + sentTotal,
    categories: mergeCounts(prevSrc.categories, categories),
  };

  for (const [userId, subCounts] of Object.entries(perUser || {})) {
    digest.users[userId] ??= {};
    for (const [subId, { count, sub }] of Object.entries(subCounts)) {
      const prev = digest.users[userId][subId];
      digest.users[userId][subId] = {
        count: (prev?.count || 0) + count,
        label: prev?.label || subLabel(sub),
      };
    }
  }

  await saveDigest(env, d, digest);
  return digest;
}

// ── Недельная статистика (7 дней) ───────────────────────────

/** Список из n дат YYYY-MM-DD, идущих назад от endDate (включительно), UTC. */
function lastNDatesUTC(n, endDate) {
  const end = endDate ? new Date(`${endDate}T00:00:00Z`) : new Date();
  const dates = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/** Схлопывает несколько дневных дайджестов в один агрегат {sources, users}. */
export function aggregateDigests(digests) {
  const combined = { sources: {}, users: {} };

  for (const digest of digests) {
    for (const [source, stats] of Object.entries(digest.sources || {})) {
      const prev = combined.sources[source] || { newLots: 0, sent: 0, categories: {} };
      combined.sources[source] = {
        newLots:    prev.newLots + (stats.newLots || 0),
        sent:       prev.sent    + (stats.sent    || 0),
        categories: mergeCounts(prev.categories, stats.categories),
      };
    }

    for (const [userId, subCounts] of Object.entries(digest.users || {})) {
      combined.users[userId] ??= {};
      for (const [subId, { count, label }] of Object.entries(subCounts)) {
        const prev = combined.users[userId][subId];
        combined.users[userId][subId] = {
          count: (prev?.count || 0) + count,
          label: prev?.label || label,
        };
      }
    }
  }

  return combined;
}

/**
 * Агрегированная статистика за последние 7 дней (включая endDate).
 * @returns {{dateFrom: string, dateTo: string, sources: object, users: object}}
 */
export async function getWeeklyDigest(env, endDate) {
  const dates   = lastNDatesUTC(7, endDate);
  const digests = await Promise.all(dates.map(d => getDigest(env, d)));
  const { sources, users } = aggregateDigests(digests);
  return { dateFrom: dates[dates.length - 1], dateTo: dates[0], sources, users };
}
