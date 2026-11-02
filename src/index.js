import { writeFile } from 'node:fs/promises';
import { Checker } from './checker.js';
import { configuredNotifiers, notifyAll } from './notify.js';
import { PushStore } from './push.js';
import { startServer } from './server.js';

const args = new Set(process.argv.slice(2));
const env = process.env;
const log = (...m) => console.log(new Date().toISOString(), ...m);

async function main() {
  const push = await new PushStore({
    env,
    keysFile: env.VAPID_FILE || '.vapid.json',
    subscriptionsFile: env.SUBSCRIPTIONS_FILE || 'subscriptions.json',
    log,
  }).init();

  if (args.has('--test-notify')) {
    const notifiers = configuredNotifiers(env, { push });
    if (notifiers.length === 0) {
      throw new Error('No notifier configured; turn on notifications in the UI or set RESEND_API_KEY+EMAIL_TO, NTFY_TOPIC or DISCORD_WEBHOOK_URL');
    }
    const ok = await notifyAll(notifiers, { subject: 'apple-stock test notification', text: 'Notifications are working.' }, log);
    process.exit(ok ? 0 : 1);
  }

  const once = args.has('--once');
  const checker = new Checker({
    env,
    settingsFile: env.SETTINGS_FILE || 'settings.json',
    stateFile: env.STATE_FILE || '.state.json',
    headless: env.HEADLESS !== 'false',
    dryRun: args.has('--dry-run'),
    log,
    push,
  });
  await checker.init();
  if (checker.notifiers().length === 0) log('no notifier yet: turn on notifications in the UI or configure one in .env');

  if (once) {
    await checker.check();
    await checker.close();
    if (checker.error) process.exit(1);
    return;
  }

  const baseS = Math.max(30, Number(env.INTERVAL_SECONDS || 30));
  const fastS = Math.max(15, Number(env.FAST_INTERVAL_S || 30));
  // FAST_WINDOWS like "08:15-09:00,14:30-19:30" in Singapore time (UTC+8).
  const windows = String(env.FAST_WINDOWS || '').split(',').map((w) => w.trim().match(/^(\d\d):(\d\d)-(\d\d):(\d\d)$/)).filter(Boolean)
    .map((m) => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  const sgtMinute = () => { const d = new Date(Date.now() + 8 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const inFast = () => { const m = sgtMinute(); return windows.some(([a, b]) => m >= a && m < b); };
  let backoff = 1;
  let lastFast = null;
  log(`intervals: ${baseS}s normally, ${fastS}s in fast windows ${env.FAST_WINDOWS || '(none)'} SGT`);
  let timer;
  const schedule = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const started = Date.now();
      try { await checker.check(); } catch (err) { log(`check crashed: ${err.message}`); }
      writeFile(env.HEARTBEAT_FILE || '.heartbeat', new Date().toISOString() + '\n').catch(() => {});
      if (checker.blocked) {
        backoff = Math.min(backoff * 2, 8);
        log(`blocked/rate-limited (${checker.error}); backing off x${backoff}`);
      } else if (!checker.error) backoff = 1;
      const fast = inFast();
      if (fast !== lastFast) { log(fast ? `fast window: checking every ~${fastS}s` : `normal interval: ~${baseS}s`); lastFast = fast; }
      const target = (fast ? fastS : baseS) * 1000 * backoff * (0.8 + Math.random() * 0.4);
      // Interval is start-to-start; never wait less than 5s between checks.
      schedule(Math.max(5000, target - (Date.now() - started)));
    }, delay);
  };

  if (!args.has('--no-ui')) {
    startServer(checker, {
      host: env.HOST || '127.0.0.1',
      port: Number(env.PORT || 4321),
      log,
      onSettingsChanged: () => schedule(0),
    });
  }
  schedule(0);
  // Watchdog: if no check has finished for 4 min (or the event loop jumped, e.g. host pause), restart cleanly.
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 60_000) log(`clock jump ${Math.round((now - lastTick) / 1000)}s: host was paused`);
    lastTick = now;
    if (checker.lastChecked && now - Date.parse(checker.lastChecked) > 240_000 && !checker.checking) schedule(0);
  }, 15_000).unref();

  const shutdown = async () => {
    clearTimeout(timer);
    await checker.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
