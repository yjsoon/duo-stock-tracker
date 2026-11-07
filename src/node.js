// Self-hosted runner. Needs only Node.js 22.9+ and no npm packages.
//   node --env-file-if-exists=.env src/node.js               check on a loop
//   node --env-file-if-exists=.env src/node.js --once        one check, exit 1 if Apple did not answer cleanly
//   node --env-file-if-exists=.env src/node.js --test-notify send a test ntfy message
//   node src/node.js --models [product-url]                  list part numbers for MODELS
import { readFileSync, unlinkSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { listModels, newState, readConfig, runCheck, sendTestNotification, shopPath } from './core.js';

const args = process.argv.slice(2);
const log = (...m) => console.log(new Date().toISOString(), ...m);
const stateFile = process.env.STATE_FILE || '.state.json';

// One process owns STATE_FILE at a time, so `npm run check` next to `npm start` (or two loops) cannot both load
// the same old state and send the same alert. The lock is created atomically (O_EXCL) and fails closed: any
// existing lock, even an empty one or one left by a crash, stops this process. Removing a stale lock is a manual
// step, because "is that PID still alive?" cannot be answered safely (PIDs are reused, especially after a reboot).
async function lockState() {
  const lock = `${stateFile}.lock`;
  const mine = `${process.pid} ${Date.now()}\n`;
  try {
    await writeFile(lock, mine, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const owner = (await readFile(lock, 'utf8').catch(() => '')).trim().split(' ')[0] || 'unknown';
    throw new Error(
      `${stateFile} is locked by process ${owner} (${lock}). If \`npm start\` or the service is running, stop it first or set ` +
        `STATE_FILE to another file. If no checker is running (it crashed or the machine rebooted), delete ${lock} and retry.`,
    );
  }
  // Remove the lock on exit only while it is still ours.
  process.on('exit', () => {
    try {
      if (readFileSync(lock, 'utf8') === mine) unlinkSync(lock);
    } catch {}
  });
}

async function loadState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return newState();
    throw err;
  }
}

async function saveState(state) {
  await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(`${stateFile}.tmp`, stateFile);
}

async function main() {
  if (args[0] === '--models') {
    const country = String(process.env.COUNTRY || 'sg').toLowerCase();
    const url = args[1] || process.env.PRODUCT_URL || `https://www.apple.com${shopPath(country)}/buy-iphone/iphone-duo`;
    const models = await listModels(url);
    if (!models.length) throw new Error(`no part numbers found on ${url}`);
    for (const m of models) console.log(`${m.partNumber}\t${m.name}`);
    return;
  }

  const config = readConfig(process.env);
  if (args.includes('--test-notify')) {
    await sendTestNotification(config);
    log(`sent a test notification to ${config.ntfyServer}/<NTFY_TOPIC>`);
    return;
  }

  await lockState();
  let timer;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearTimeout(timer); process.exit(0); });
  let state = await loadState();
  const check = async () => {
    const result = await runCheck(config, state);
    state = result.state;
    await saveState(state);
    log(result.line);
    return result;
  };

  if (args.includes('--once')) {
    const { state: s } = await check();
    process.exitCode = s.failures ? 1 : 0;
    return;
  }

  log(`watching ${config.models.join(', ')} near ${config.postalCode}, about every ${config.intervalS}s`);
  const loop = async () => {
    let delayMs = config.intervalS * 1000;
    try {
      ({ delayMs } = await check());
    } catch (err) {
      log(`check crashed: ${err.message}`);
    }
    log(`next check in ${Math.round(delayMs / 1000)}s`);
    timer = setTimeout(loop, delayMs);
  };
  loop();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
