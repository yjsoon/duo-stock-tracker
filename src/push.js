import { readFile, writeFile } from 'node:fs/promises';
import webpush from 'web-push';

const GONE = new Set([404, 410]);

export class PushStore {
  constructor({ env = {}, keysFile, subscriptionsFile, sender = webpush.sendNotification, log = () => {} }) {
    this.env = env;
    this.keysFile = keysFile;
    this.subscriptionsFile = subscriptionsFile;
    this.sender = sender;
    this.log = log;
    this.subscriptions = [];
  }

  async init() {
    const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = this.env;
    this.keys = publicKey && privateKey ? { publicKey, privateKey } : await readJson(this.keysFile);
    if (!this.keys) {
      this.keys = webpush.generateVAPIDKeys();
      await writeFile(this.keysFile, JSON.stringify(this.keys, null, 2) + '\n', { mode: 0o600 });
      this.log(`generated web push keys in ${this.keysFile}`);
    }
    this.subscriptions = (await readJson(this.subscriptionsFile)) ?? [];
    return this;
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  get size() {
    return this.subscriptions.length;
  }

  get subject() {
    if (this.env.VAPID_SUBJECT) return this.env.VAPID_SUBJECT;
    const email = this.env.EMAIL_TO?.split(',')[0].trim();
    return email ? `mailto:${email}` : 'https://github.com/kelindi/apple-stock';
  }

  async add(subscription) {
    const sub = validSubscription(subscription);
    this.subscriptions = [...this.subscriptions.filter((s) => s.endpoint !== sub.endpoint), sub];
    await this.save();
  }

  async remove(endpoint) {
    const before = this.size;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.size !== before) await this.save();
  }

  async send({ subject, text, url }) {
    if (this.size === 0) throw new Error('no devices have notifications turned on');
    const payload = JSON.stringify({ title: subject, body: text, url });
    const options = {
      TTL: 60 * 60,
      urgency: 'high',
      vapidDetails: { subject: this.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
    };
    const subs = [...this.subscriptions];
    const results = await Promise.allSettled(subs.map((s) => this.sender(s, payload, options)));
    const gone = subs.filter((s, i) => GONE.has(results[i].reason?.statusCode)).map((s) => s.endpoint);
    if (gone.length) {
      this.subscriptions = this.subscriptions.filter((s) => !gone.includes(s.endpoint));
      await this.save();
      this.log(`removed ${gone.length} expired push subscription(s)`);
    }
    if (!results.some((r) => r.status === 'fulfilled')) {
      const err = results.find((r) => r.status === 'rejected')?.reason;
      throw new Error(`push failed: ${err?.statusCode ?? ''} ${err?.body || err?.message || err}`.trim());
    }
  }

  async save() {
    await writeFile(this.subscriptionsFile, JSON.stringify(this.subscriptions, null, 2) + '\n', { mode: 0o600 });
  }
}

export function validSubscription(sub) {
  let url;
  try {
    url = new URL(sub?.endpoint);
  } catch {
    throw new Error('invalid push subscription');
  }
  const { p256dh, auth } = sub.keys ?? {};
  if (url.protocol !== 'https:' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    throw new Error('invalid push subscription');
  }
  return { endpoint: url.href, keys: { p256dh, auth } };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
