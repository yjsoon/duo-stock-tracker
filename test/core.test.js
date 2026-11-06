import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextDelayMs, readConfig, runCheck } from '../src/core.js';
import { parsePickup, parseProducts } from '../src/parse.js';

// A real response from /sg/shop/retail/pickup-message (6 Nov 2026), trimmed to the fields the parser reads.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sg-pickup-message.json', import.meta.url), 'utf8'));
const WHITE = 'MK2F4X/A';
const BLACK = 'MK2G4X/A';
const config = readConfig({ POSTAL_CODE: '238857', MODELS: `${WHITE},${BLACK}`, NTFY_TOPIC: 'test-topic-0123456789', NTFY_SERVER: 'https://ntfy.example' });
const MIN = 60_000;

// Clone of the fixture with the given store/part pairs available and, optionally, some stores left out.
function pickup(available = [], { omit = [] } = {}) {
  const json = structuredClone(fixture);
  json.body.stores = json.body.stores.filter((s) => !omit.includes(s.storeNumber));
  for (const s of json.body.stores) {
    for (const [pn, p] of Object.entries(s.partsAvailability)) {
      if (available.includes(`${s.storeNumber}:${pn}`)) Object.assign(p, { pickupDisplay: 'available', pickupSearchQuote: 'Available Today' });
    }
  }
  return json;
}

// Fake fetch: Apple answers from `apple` (a JSON body, or [status, body, headers]); ntfy answers `ntfyStatus`.
function fakeFetch() {
  const f = async (url, init = {}) => {
    if (url.startsWith('https://ntfy.example/')) {
      f.ntfy.push({ url, ...init, json: JSON.parse(init.body) });
      return new Response(f.ntfyStatus === 200 ? '{}' : 'limit reached', { status: f.ntfyStatus });
    }
    f.apple.push({ url, ...init });
    const [status, body, headers] = Array.isArray(f.next) ? f.next : [200, JSON.stringify(f.next)];
    return new Response(body, { status, headers });
  };
  Object.assign(f, { ntfy: [], apple: [], ntfyStatus: 200, next: pickup() });
  return f;
}

test('parses the live Singapore pickup response: three stores, both parts unavailable', () => {
  const rows = parsePickup(fixture);
  assert.equal(rows.length, 6);
  assert.deepEqual([...new Set(rows.map((r) => `${r.storeNumber} ${r.storeName} ${r.distanceKm}`))], ['R669 Orchard Road 0.02', 'R633 Marina Bay Sands 3.21', 'R736 Jewel Changi Airport 18.2']);
  assert.ok(rows.every((r) => !r.available && r.quote === 'Currently unavailable'));
  assert.equal(rows.find((r) => r.partNumber === WHITE).title, 'iPhone Duo 512GB Star White');
  assert.deepEqual(new Set(parsePickup(fixture, { maxDistanceKm: 10 }).map((r) => r.storeNumber)), new Set(['R669', 'R633']));
});

test('a find alerts once in one ntfy message, and failed or partial checks never re-arm it', async () => {
  const f = fakeFetch();
  const noCooldown = { ...config, cooldownMs: 0 };
  let state;
  const check = async (next, now) => {
    f.next = next;
    ({ state } = await runCheck(noCooldown, state, { fetch: f, now }));
  };
  await check(pickup(), 0);
  assert.equal(f.ntfy.length, 0);

  await check(pickup([`R669:${WHITE}`, `R736:${BLACK}`]), 2 * MIN);
  assert.equal(f.ntfy.length, 1, 'two finds in one check share one message');
  const sent = f.ntfy[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://ntfy.example/');
  assert.equal(sent.json.topic, 'test-topic-0123456789');
  assert.equal(sent.json.title, 'In stock: iPhone Duo 512GB Star White at Orchard Road (+1 more)');
  assert.equal(sent.json.priority, 4);
  assert.equal(sent.json.click, config.productUrl);
  assert.match(sent.json.message, /iPhone Duo 512GB Night Sky: pickup at Apple Jewel Changi Airport \(18\.2 km\)/);

  await check([541, '<html><title>Page Not Found</title></html>'], 4 * MIN);
  await check(pickup([], { omit: ['R669', 'R736'] }), 6 * MIN); // stores missing from a response are unknown, not sold out
  await check(pickup([`R669:${WHITE}`, `R736:${BLACK}`]), 8 * MIN);
  assert.equal(f.ntfy.length, 1);
});

test('sold out then back alerts again only after the cooldown', async () => {
  const f = fakeFetch();
  let state;
  const check = async (next, now) => {
    f.next = next;
    ({ state } = await runCheck(config, state, { fetch: f, now }));
  };
  await check(pickup([`R633:${WHITE}`]), 0);
  await check(pickup(), 2 * MIN);
  await check(pickup([`R633:${WHITE}`]), 4 * MIN); // flapped within ALERT_COOLDOWN_MIN (60)
  assert.equal(f.ntfy.length, 1);
  await check(pickup(), 30 * MIN);
  await check(pickup([`R633:${WHITE}`]), 61 * MIN);
  assert.equal(f.ntfy.length, 2);
});

test('when ntfy rejects an alert it is retried on the next check, then not repeated', async () => {
  const f = fakeFetch();
  f.ntfyStatus = 429;
  f.next = pickup([`R669:${BLACK}`]);
  let { state, line } = await runCheck(config, undefined, { fetch: f, now: 0 });
  assert.match(line, /ntfy failed \(ntfy HTTP 429/);
  f.ntfyStatus = 200;
  ({ state } = await runCheck(config, state, { fetch: f, now: 2 * MIN }));
  ({ state } = await runCheck(config, state, { fetch: f, now: 4 * MIN }));
  assert.equal(f.ntfy.length, 2);
  assert.deepEqual(Object.keys(state.available), [`pickup:R669:${BLACK}`]);
});

test('403/429 back off and drop the session; 541 keeps the cadence; Retry-After is honoured but capped', async () => {
  const f = fakeFetch();
  f.next = [200, JSON.stringify(pickup()), { 'Set-Cookie': 'shld=abc; Path=/; Secure' }];
  let { state } = await runCheck(config, undefined, { fetch: f, now: 0 });
  f.next = [541, 'nope'];
  let result = await runCheck(config, state, { fetch: f, now: 1, random: () => 1 });
  assert.equal(f.apple[1].headers.Cookie, 'shld=abc', 'session cookie is sent back');
  assert.equal(result.state.backoff, 1);
  assert.equal(result.delayMs, 144_000);
  f.next = [429, 'slow down', { 'Retry-After': '600' }];
  result = await runCheck(config, result.state, { fetch: f, now: 2, random: () => 0 });
  assert.equal(result.state.backoff, 2);
  assert.equal(result.state.cookie, null);
  assert.equal(result.delayMs, 600_000);
  f.next = [403, 'blocked', { 'Retry-After': '86400' }];
  result = await runCheck(config, result.state, { fetch: f, now: 3, random: () => 0 });
  assert.equal(result.state.backoff, 4);
  assert.equal(result.delayMs, 15 * MIN);
  f.next = pickup();
  result = await runCheck(config, result.state, { fetch: f, now: 4 });
  assert.equal(result.state.backoff, 1);
  assert.equal(nextDelayMs(config, 1, 0, () => 0), 96_000);
});

test('one "cannot read Apple" notice after an hour of failures, and none for a short outage', async () => {
  const f = fakeFetch();
  f.next = [541, 'nope'];
  let state;
  for (let m = 0; m <= 58; m += 2) ({ state } = await runCheck(config, state, { fetch: f, now: m * MIN }));
  assert.equal(f.ntfy.length, 0);
  for (let m = 60; m <= 90; m += 2) ({ state } = await runCheck(config, state, { fetch: f, now: m * MIN }));
  assert.equal(f.ntfy.length, 1);
  assert.equal(f.ntfy[0].json.title, 'apple-stock: cannot read Apple');
  assert.equal(f.ntfy[0].json.priority, 3);
});

test('config rejects guessable topics and malformed input', () => {
  const ok = { POSTAL_CODE: '018972', MODELS: 'mk2f4x/a', NTFY_TOPIC: 'abcdefgh-12345678' };
  assert.deepEqual(readConfig(ok).models, ['MK2F4X/A']);
  assert.equal(readConfig({ ...ok, INTERVAL_SECONDS: '15' }).intervalS, 60);
  assert.throws(() => readConfig({ ...ok, NTFY_TOPIC: 'iphone' }), /NTFY_TOPIC/);
  assert.throws(() => readConfig({ ...ok, POSTAL_CODE: '23885' }), /POSTAL_CODE/);
  assert.throws(() => readConfig({ ...ok, MODELS: 'iPhone Duo' }), /MODELS/);
});

test('lists part numbers from a product page', () => {
  const html = '<script type="application/json" id="metrics">{"data":{"products":[{"partNumber":"MK2G4X/A","name":"iPhone Duo 512GB Night Sky"},{"partNumber":"MK2F4X/A","name":"iPhone Duo 512GB Star White"},{"partNumber":"MK2F4X/A","name":"iPhone Duo 512GB Star White"}]}}</script>';
  assert.deepEqual(parseProducts(html).map((p) => p.partNumber), ['MK2G4X/A', 'MK2F4X/A']);
});
