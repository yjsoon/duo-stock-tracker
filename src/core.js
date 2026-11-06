// The check shared by the Cloudflare Worker (src/worker.js) and the self-hosted loop (src/node.js).
// Only standard fetch and plain objects: the caller loads and saves `state`.
import { parsePickup, parseProducts } from './parse.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAX_BACKOFF = 8;
const MAX_RETRY_AFTER_MS = 15 * 60_000;

// Postal code formats for the countries verified live. Any other Apple Store country code (the path segment in
// apple.com/<cc>/shop) is accepted with a loose check and is unverified.
const POSTAL = {
  sg: { re: /^\d{6}$/, example: '238857' },
  us: { re: /^\d{5}(-\d{4})?$/, example: '10001' },
  ca: { re: /^[A-Z]\d[A-Z]\d[A-Z]\d$/, example: 'M5V3L9' },
};

export const shopPath = (country) => (country === 'us' ? '/shop' : `/${country}/shop`);

export function readConfig(env) {
  const country = String(env.COUNTRY || 'sg').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) throw new Error('COUNTRY must be a 2-letter Apple Store country code, such as sg, us or ca');
  const postalCode = String(env.POSTAL_CODE ?? '').replace(/\s+/g, '').toUpperCase();
  const format = POSTAL[country] ?? { re: /^[A-Z0-9-]{3,10}$/, example: 'a postal code' };
  if (!format.re.test(postalCode)) throw new Error(`POSTAL_CODE "${postalCode}" does not look like a ${country.toUpperCase()} postal code, such as ${format.example}`);
  const models = String(env.MODELS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!models.length || models.length > 10 || !models.every((m) => /^[A-Z0-9]{4,8}\/[A-Z]$/.test(m))) {
    throw new Error('MODELS must be 1 to 10 comma-separated part numbers, such as MK2F4X/A');
  }
  const ntfyTopic = String(env.NTFY_TOPIC ?? '').trim();
  if (!/^[\w-]{16,64}$/.test(ntfyTopic)) {
    throw new Error('NTFY_TOPIC must be 16 to 64 letters, digits, - or _ (anyone who knows it can read your alerts, so make it random)');
  }
  return {
    country,
    postalCode,
    models,
    maxDistanceKm: num(env.MAX_DISTANCE_KM, 50),
    intervalS: Math.max(60, num(env.INTERVAL_SECONDS, 120)),
    cooldownMs: num(env.ALERT_COOLDOWN_MIN, 60) * 60_000,
    staleAlertMs: num(env.STALE_ALERT_MIN, 60) * 60_000,
    ntfyServer: String(env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, ''),
    ntfyTopic,
    ntfyToken: env.NTFY_TOKEN || '',
    productUrl: env.PRODUCT_URL || `https://www.apple.com${shopPath(country)}/buy-iphone/iphone-duo`,
    acceptLanguage: `en-${country.toUpperCase()},en;q=0.9`,
    appleOrigin: String(env.APPLE_ORIGIN || 'https://www.apple.com').replace(/\/+$/, ''),
  };
}

function num(value, fallback) {
  const n = Number(value);
  return value === undefined || value === '' || !Number.isFinite(n) ? fallback : n;
}

export const newState = () => ({ available: {}, alertedAt: {}, cookie: null, backoff: 1, failures: 0, failingSince: null, staleNotified: false, lastCheckAt: null, lastOkAt: null, lastStatus: null });

// One request to Apple's retail pickup endpoint. It answers a plain HTTP client, so no browser is needed.
// The session cookies Apple sets are sent back on the next check.
export async function fetchPickup(config, cookie, fetchFn = fetch) {
  const params = new URLSearchParams({ pl: 'true', location: config.postalCode });
  config.models.forEach((m, i) => params.set(`parts.${i}`, m));
  let res;
  let text;
  try {
    res = await fetchFn(`${config.appleOrigin}${shopPath(config.country)}/retail/pickup-message?${params}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': config.acceptLanguage,
        Referer: config.productUrl,
        'x-aos-ui-fetch-call-1': '1',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    // The body is read inside the same handler: a timeout or disconnect mid-body is a failed check, not a crash.
    text = await res.text();
  } catch (err) {
    return { status: res?.status ?? 0, json: null, cookie, retryAfterMs: 0, error: err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err) };
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const ok = res.status === 200 && Array.isArray(json?.body?.stores);
  return {
    status: res.status,
    json: ok ? json : null,
    cookie: mergeCookies(cookie, res.headers.getSetCookie?.() ?? []),
    retryAfterMs: retryAfterMs(res.headers.get('retry-after'), Date.now()),
    error: ok ? null : `HTTP ${res.status}${json ? '' : ' (not JSON)'}`,
  };
}

// Runs one check and returns the next state, how long to wait before the next check, and a log line.
// Alert rules:
// - a store/part alerts when it is available and was not available at the last clean check;
// - only an explicit "unavailable" in a clean response clears it, so a failed check or a missing store never re-arms an alert;
// - the same store/part alerts at most once per ALERT_COOLDOWN_MIN, even if it flaps;
// - all new finds in one check go out as one ntfy message; if ntfy fails they are retried on the next check.
export async function runCheck(config, prev, { fetch: fetchFn = fetch, now = Date.now(), random = Math.random } = {}) {
  const state = { ...newState(), ...prev, available: { ...prev?.available }, alertedAt: { ...prev?.alertedAt } };
  const res = await fetchPickup(config, state.cookie, fetchFn);
  state.cookie = res.cookie;
  state.lastCheckAt = now;
  state.lastStatus = res.status;

  if (!res.json) {
    const blocked = res.status === 403 || res.status === 429;
    if (blocked) {
      state.backoff = Math.min(state.backoff * 2, MAX_BACKOFF);
      state.cookie = null;
    }
    state.failures += 1;
    state.failingSince ??= now;
    let line = `check failed: ${res.error}; ${state.failures} in a row${blocked ? `, backing off x${state.backoff}` : ''}`;
    if (config.staleAlertMs > 0 && !state.staleNotified && now - state.failingSince >= config.staleAlertMs) {
      const minutes = Math.round((now - state.failingSince) / 60_000);
      try {
        await sendNtfy(config, { title: 'apple-stock: cannot read Apple', body: `No clean answer from Apple for ${minutes} min (last: ${res.error}). Stock is unknown until it recovers. This is not a stock alert.`, priority: 'default' }, fetchFn);
        state.staleNotified = true;
        line += '; sent a one-off "cannot read Apple" notice';
      } catch (err) {
        line += `; notice failed: ${err.message}`;
      }
    }
    return { state, delayMs: nextDelayMs(config, state.backoff, res.retryAfterMs, random), line, alerted: [] };
  }

  Object.assign(state, { backoff: 1, failures: 0, failingSince: null, staleNotified: false, lastOkAt: now });
  const rows = parsePickup(res.json, { maxDistanceKm: config.maxDistanceKm });
  // available is true, false (Apple explicitly says unavailable) or null (unknown). Only false clears a find.
  for (const r of rows) if (r.available === false) delete state.available[keyOf(r)];
  const fresh = rows.filter((r) => r.available === true && !(keyOf(r) in state.available));
  const due = fresh.filter((r) => !(now - (state.alertedAt[keyOf(r)] ?? -Infinity) < config.cooldownMs));
  let sent = false;
  let note = '';
  if (due.length) {
    try {
      await sendNtfy(config, stockMessage(due, config.productUrl), fetchFn);
      sent = true;
      for (const r of due) state.alertedAt[keyOf(r)] = now;
      note = `; alerted: ${stockMessage(due, config.productUrl).title}`;
    } catch (err) {
      note = `; ntfy failed (${err.message}), will retry next check`;
    }
  }
  for (const r of fresh) if (sent || !due.includes(r)) state.available[keyOf(r)] = now;
  for (const [k, at] of Object.entries(state.alertedAt)) if (now - at >= config.cooldownMs) delete state.alertedAt[k];

  const stores = new Set(rows.map((r) => r.storeNumber)).size;
  const available = rows.filter((r) => r.available === true).length;
  const sample = rows.find((r) => r.available === true) ?? rows[0];
  const line = `checked ${config.models.length} model(s) at ${stores} store(s) within ${config.maxDistanceKm} km of ${config.postalCode}: ${available} available, ${fresh.length} new${sample ? ` (e.g. "${sample.quote}")` : ''}${note}`;
  return { state, delayMs: nextDelayMs(config, 1, res.retryAfterMs, random), line, alerted: sent ? due : [] };
}

export const keyOf = (r) => `pickup:${r.storeNumber}:${r.partNumber}`;

// One line per model listing every store that has it, so every find fits in one small message
// (10 models x a dozen nearby stores stays under ntfy's 4 KB message limit).
export function stockMessage(rows, productUrl) {
  const first = rows[0];
  const more = rows.length > 1 ? ` (+${rows.length - 1} more)` : '';
  const byModel = new Map();
  for (const r of rows) byModel.set(r.title, [...(byModel.get(r.title) ?? []), `${r.storeName} (${r.distance})`]);
  return {
    title: `In stock: ${first.title} at ${first.storeName}${more}`,
    body: [...byModel].map(([title, stores]) => `${title}: pickup at ${stores.join(', ')}`).join('\n'),
    click: productUrl,
    priority: 'high',
  };
}

// Start-to-start gap: INTERVAL_SECONDS +-20% jitter, times the 403/429 backoff, and never shorter than Retry-After (capped).
export function nextDelayMs(config, backoff, retryAfter = 0, random = Math.random) {
  const base = config.intervalS * 1000 * (0.8 + 0.4 * random()) * backoff;
  return Math.round(Math.max(base, Math.min(retryAfter, MAX_RETRY_AFTER_MS)));
}

const PRIORITY = { default: 3, high: 4 };

// ntfy's JSON publish format, so titles with non-ASCII characters (Apple uses no-break spaces) arrive intact.
export async function sendNtfy(config, { title, body, click, priority = 'high' }, fetchFn = fetch) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;
  const message = { topic: config.ntfyTopic, title, message: body, priority: PRIORITY[priority], tags: ['iphone'], ...(click ? { click } : {}) };
  const res = await fetchFn(`${config.ntfyServer}/`, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function sendTestNotification(config, fetchFn = fetch) {
  return sendNtfy(config, { title: 'apple-stock test notification', body: `Alerts for ${config.models.join(', ')} near ${config.postalCode} will arrive here.`, click: config.productUrl, priority: 'default' }, fetchFn);
}

// Part numbers on an Apple Store product page, for choosing MODELS.
export async function listModels(productUrl, fetchFn = fetch) {
  const res = await fetchFn(productUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'en,en-US;q=0.9' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${productUrl} returned HTTP ${res.status}`);
  return parseProducts(await res.text());
}

export function mergeCookies(existing, setCookies = []) {
  const jar = new Map();
  for (const pair of [...String(existing || '').split(';'), ...setCookies.map((c) => String(c).split(';')[0])]) {
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : null;
}

function retryAfterMs(header, nowMs) {
  if (!header) return 0;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : 0;
}
