import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs real `src/node.js --once` processes against a local mock of Apple and ntfy (no outside network).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sg-pickup-message.json', import.meta.url), 'utf8'));
Object.assign(fixture.body.stores[0].partsAvailability['MK2G4X/A'], { pickupDisplay: 'available', pickupSearchQuote: 'Available Today' });
const nodeJs = new URL('../src/node.js', import.meta.url).pathname;

// Apple's answer is held until `release()`, so the run that wins the lock is still checking while the others start.
async function mock() {
  const hits = { apple: 0, ntfy: 0 };
  const held = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      hits.ntfy++;
      return res.end('{}');
    }
    hits.apple++;
    if (released) res.end(JSON.stringify(fixture));
    else held.push(res);
  });
  let released = false;
  const release = () => {
    released = true;
    held.splice(0).forEach((res) => res.end(JSON.stringify(fixture)));
  };
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { hits, server, release, origin: `http://127.0.0.1:${server.address().port}` };
}

// Starts n processes at once and releases Apple's answer once all but one have exited.
async function runMany(n, env, release) {
  let exited = 0;
  const runs = Array.from({ length: n }, () => {
    const child = spawn(process.execPath, [nodeJs, '--once'], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    return once(child, 'exit').then(([code]) => {
      if (++exited >= n - 1) release();
      return { code, out };
    });
  });
  return Promise.all(runs);
}

function setup(origin) {
  const dir = mkdtempSync(join(tmpdir(), 'apple-stock-lock-'));
  const stateFile = join(dir, 'state.json');
  const env = { POSTAL_CODE: '238857', MODELS: 'MK2F4X/A,MK2G4X/A', NTFY_TOPIC: 'lock-test-0123456789', NTFY_SERVER: origin, APPLE_ORIGIN: origin, STATE_FILE: stateFile };
  return { env, lock: `${stateFile}.lock` };
}

test('of 12 simultaneous --once runs exactly one checks and alerts; the rest refuse', async () => {
  const { hits, server, release, origin } = await mock();
  try {
    const { env, lock } = setup(origin);
    const results = await runMany(12, env, release);
    assert.equal(results.filter((r) => r.code === 0).length, 1, results.map((r) => r.out).join(''));
    assert.ok(results.filter((r) => r.code !== 0).every((r) => /is locked/.test(r.out)));
    assert.deepEqual(hits, { apple: 1, ntfy: 1 });
    assert.equal(existsSync(lock), false, 'the owner removes its lock on exit');
  } finally {
    server.close();
  }
});

test('a leftover lock, even from a dead process or empty, makes every run refuse and is left alone', async () => {
  const { hits, server, release, origin } = await mock();
  try {
    for (const content of ['2147483647\n', '']) {
      const { env, lock } = setup(origin);
      writeFileSync(lock, content);
      const results = await runMany(12, env, release);
      assert.ok(results.every((r) => r.code === 1 && /is locked/.test(r.out)), results.map((r) => r.out).join(''));
      assert.equal(readFileSync(lock, 'utf8'), content);
    }
    assert.deepEqual(hits, { apple: 0, ntfy: 0 });
  } finally {
    server.close();
  }
});
