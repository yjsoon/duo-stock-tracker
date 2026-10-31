import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const STATIC = {
  '/': ['ui.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.png': ['icon.png', 'image/png'],
};

export function startServer(checker, { host, port, log, onSettingsChanged }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const file = req.method === 'GET' && STATIC[url.pathname];
      if (file) {
        res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
        return res.end(await readFile(new URL(`./${file[0]}`, import.meta.url)));
      }
      const push = checker.push;
      if (push && url.pathname.startsWith('/api/push/')) {
        if (req.method === 'GET' && url.pathname === '/api/push/key') return json(res, { publicKey: push.publicKey });
        if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
          await push.add(await readJson(req));
          return json(res, { devices: push.size });
        }
        if (req.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
          await push.remove((await readJson(req)).endpoint);
          return json(res, { devices: push.size });
        }
        if (req.method === 'POST' && url.pathname === '/api/push/test') {
          await push.send({ subject: 'Notifications are on', text: 'You’ll get an alert here when it’s in stock.', url: '/' });
          return json(res, { devices: push.size });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/ntfy/test') {
        await checker.testNotifier('ntfy');
        return json(res, {});
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, checker.snapshot());
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const changed = await checker.updateSettings(await readJson(req));
        if (changed) onSettingsChanged();
        return json(res, checker.snapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/check') {
        onSettingsChanged();
        return json(res, { ...checker.snapshot(), checking: true });
      }
      res.writeHead(404).end();
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });
  server.listen(port, host, () => log(`ui on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
  return server;
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}
