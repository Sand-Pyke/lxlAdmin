import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'vite';
import { createProxyOptions } from '../config/proxy.mjs';

test('proxy preserves cookie auth and keeps same-origin CSRF enforcement', async (t) => {
  const seen = [];
  const backend = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      const originHost = new URL(req.headers.origin || 'http://unknown').host;
      if (
        originHost !== req.headers['x-forwarded-host'] ||
        ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])
      ) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: '跨站请求已拒绝' }));
        return;
      }
    }
    if (req.url === '/api/login')
      res.setHeader('set-cookie', 'lxl_session=test-session; Path=/; HttpOnly; SameSite=Lax');
    if (req.url === '/api/logout')
      res.setHeader('set-cookie', 'lxl_session=; Path=/; HttpOnly; Max-Age=0');
    res.end(JSON.stringify({ ok: true, cookie: req.headers.cookie || '', path: req.url }));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const target = `http://127.0.0.1:${backend.address().port}`;
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api/': createProxyOptions(target), '/assets/': createProxyOptions(target) },
    },
  });
  await vite.listen();
  t.after(() => vite.close());
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const response = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: {
      origin,
      'sec-fetch-site': 'same-origin',
      'x-forwarded-host': 'attacker.invalid',
      'x-forwarded-for': 'forged-ip',
    },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(seen[0]['x-forwarded-host'], new URL(origin).host);
  assert.notEqual(seen[0]['x-forwarded-for'], 'forged-ip');
  assert.equal(seen[0].origin, origin);
  const current = await fetch(`${origin}/api/current_user`, {
    headers: { cookie: 'lxl_session=test-session' },
  });
  assert.equal((await current.json()).cookie, 'lxl_session=test-session');
  const foreign = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { origin: 'https://evil.invalid', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(foreign.status, 403);
  const sibling = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { origin, 'sec-fetch-site': 'same-site' },
  });
  assert.equal(sibling.status, 403);
  const logout = await fetch(`${origin}/api/logout`, { method: 'POST', headers: { origin } });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  const asset = await fetch(`${origin}/assets/shop-icons/a.svg`);
  assert.equal((await asset.json()).path, '/assets/shop-icons/a.svg');
});

test('proxy refuses credentials, paths, and non-HTTP upstreams', () => {
  for (const target of [
    'file:///tmp/x',
    'https://u:p@example.com',
    'https://example.com/api',
    'https://example.com/?token=secret',
  ]) {
    assert.throws(() => createProxyOptions(target));
  }
});
