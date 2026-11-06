// Cloudflare Worker runner. One Durable Object keeps the state and schedules each check with an alarm;
// the cron trigger only re-arms that alarm if it is ever missing.
import { DurableObject } from 'cloudflare:workers';
import { readConfig, runCheck, sendTestNotification } from './core.js';

export class Watcher extends DurableObject {
  // Overlapping triggers (alarm, POST /check) share the check already in flight instead of queueing a second
  // Apple request behind it, so a 429 with Retry-After is not followed by an immediate retry.
  check() {
    this.running ??= this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async runOnce() {
    let delayMs = 10 * 60_000;
    try {
      const config = readConfig(this.env);
      const result = await runCheck(config, (await this.ctx.storage.get('state')) ?? undefined);
      await this.ctx.storage.put('state', result.state);
      delayMs = result.delayMs;
      console.log(result.line);
      return { ok: result.state.failures === 0, line: result.line };
    } catch (err) {
      console.log(`check crashed: ${err.message}`);
      return { ok: false, line: `check crashed: ${err.message}` };
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
    }
  }

  alarm() {
    return this.check();
  }

  // Cron safety net. A running check re-arms the alarm itself when it finishes.
  async ensure() {
    if (this.running) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async status() {
    const s = (await this.ctx.storage.get('state')) ?? {};
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    return {
      lastCheckAt: iso(s.lastCheckAt),
      lastOkAt: iso(s.lastOkAt),
      lastStatus: s.lastStatus ?? null,
      consecutiveFailures: s.failures ?? 0,
      backoff: s.backoff ?? 1,
      nextCheckAt: iso(await this.ctx.storage.getAlarm()),
      available: Object.keys(s.available ?? {}),
    };
  }

  testNotify() {
    return sendTestNotification(readConfig(this.env));
  }
}

// Place the Durable Object near the stores it checks. This only applies when the object is first created.
const REGION = { sg: 'apac', us: 'enam', ca: 'enam' };
const watcher = (env) => {
  const locationHint = REGION[String(env.COUNTRY || 'sg').toLowerCase()];
  return env.WATCHER.get(env.WATCHER.idFromName('watcher'), locationHint ? { locationHint } : {});
};

function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const given = new TextEncoder().encode(request.headers.get('Authorization') ?? '');
  const want = new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
  return given.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(given, want);
}

export default {
  // GET /status, POST /check and POST /test-notify, all behind `Authorization: Bearer <ADMIN_TOKEN>`.
  async fetch(request, env) {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (!['GET /status', 'POST /check', 'POST /test-notify'].includes(route)) return new Response('not found', { status: 404 });
    if (!authorized(request, env)) return new Response('unauthorized', { status: 401 });
    const stub = watcher(env);
    try {
      if (route === 'GET /status') return Response.json(await stub.status());
      if (route === 'POST /check') return Response.json(await stub.check());
      await stub.testNotify();
      return Response.json({ ok: true, sent: 'apple-stock test notification' });
    } catch (err) {
      return Response.json({ ok: false, error: err.message }, { status: 500 });
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(watcher(env).ensure());
  },
};
