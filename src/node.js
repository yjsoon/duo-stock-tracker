// Self-hosted runner. Needs only Node.js 22.9+ and no npm packages.
//   node --env-file-if-exists=.env src/node.js               check on a loop
//   node --env-file-if-exists=.env src/node.js --once        one check, exit 1 if Apple did not answer cleanly
//   node --env-file-if-exists=.env src/node.js --test-notify send a test ntfy message
//   node src/node.js --models [product-url]                  list part numbers for MODELS
import { readFile, rename, writeFile } from 'node:fs/promises';
import { listModels, newState, readConfig, runCheck, sendTestNotification } from './core.js';

const args = process.argv.slice(2);
const log = (...m) => console.log(new Date().toISOString(), ...m);
const stateFile = process.env.STATE_FILE || '.state.json';

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
    const url = args[1] || process.env.PRODUCT_URL || 'https://www.apple.com/sg/shop/buy-iphone/iphone-duo';
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
  let timer;
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
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearTimeout(timer); process.exit(0); });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
