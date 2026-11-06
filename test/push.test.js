import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushStore, validSubscription } from '../src/push.js';
import { configuredNotifiers } from '../src/notify.js';

const sub = (n) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

async function store(sender) {
  const dir = await mkdtemp(join(tmpdir(), 'push-'));
  const s = await new PushStore({ keysFile: join(dir, 'k.json'), subscriptionsFile: join(dir, 's.json'), sender }).init();
  return { s, dir };
}

test('validSubscription rejects junk and non-https endpoints', () => {
  assert.throws(() => validSubscription({}), /invalid/);
  assert.throws(() => validSubscription({ endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } }), /invalid/);
  assert.deepEqual(validSubscription({ ...sub(1), extra: 1 }), sub(1));
});

test('PushStore generates and reuses VAPID keys, dedupes subscriptions', async () => {
  const { s, dir } = await store();
  assert.match(s.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  await s.add(sub(1));
  await s.add(sub(1));
  await s.add(sub(2));
  assert.equal(s.size, 2);
  const again = await new PushStore({ keysFile: join(dir, 'k.json'), subscriptionsFile: join(dir, 's.json') }).init();
  assert.equal(again.publicKey, s.publicKey);
  assert.equal(again.size, 2);
  assert.equal(configuredNotifiers({}, { push: again })[0].name, 'push');
  await again.remove(sub(1).endpoint);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 's.json'), 'utf8')), [sub(2)]);
});

test('PushStore.send drops expired subscriptions and fails only if all fail', async () => {
  const sent = [];
  const { s } = await store(async (target, payload) => {
    sent.push([target.endpoint, JSON.parse(payload).title]);
    if (target.endpoint.endsWith('/2')) throw Object.assign(new Error('gone'), { statusCode: 410 });
  });
  await assert.rejects(s.send({ subject: 'x' }), /no devices/);
  await s.add(sub(1));
  await s.add(sub(2));
  await s.send({ subject: 'In stock', text: 't' });
  assert.deepEqual(sent, [['https://push.example/1', 'In stock'], ['https://push.example/2', 'In stock']]);
  assert.equal(s.size, 1);
  s.sender = async () => { throw Object.assign(new Error('nope'), { statusCode: 403, body: 'BadJwtToken' }); };
  await assert.rejects(s.send({ subject: 'x' }), /403 BadJwtToken/);
});

test('normalizeTopic accepts topics and ntfy URLs, rejects junk', async () => {
  const { normalizeTopic } = await import('../src/checker.js');
  assert.equal(normalizeTopic(' apple-stock-ab12 '), 'apple-stock-ab12');
  assert.equal(normalizeTopic('https://ntfy.sh/my_topic'), 'my_topic');
  assert.equal(normalizeTopic(''), '');
  assert.throws(() => normalizeTopic('bad topic!'), /letters/);
});
