import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { sourceLoader } from './helpers/load-source.mjs';

const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const bcrypt = require('bcryptjs');
const secret = 'isolated-management-test-secret-only-0000000000000000';
process.env.ADMIN_SESSION_SECRET = secret;
process.env.NODE_ENV = 'test';
const users = [
  { id: 1, username: 'core', isAdmin: true, isCoreAdmin: true },
  { id: 2, username: 'reviewer', isAdmin: true, isSecondaryAdmin: true },
  { id: 3, username: 'admin', isAdmin: true },
  { id: 53, username: 'player', isAdmin: false },
].map((user) => ({
  status: 'APPROVED',
  isCoreAdmin: false,
  isSecondaryAdmin: false,
  ...user,
  passwordHash: bcrypt.hashSync('fixture-only', 4),
}));
function database() {
  const writes = [];
  return {
    writes,
    user: {
      findUnique: async ({ where }) =>
        users.find((user) => (where.id ? user.id === where.id : user.username === where.username)),
      update: async (input) => {
        writes.push(['user', input]);
        return {};
      },
    },
    playerProfile: {
      upsert: async (input) => {
        writes.push(['profile', input]);
        return {};
      },
    },
    matchSignup: {
      updateMany: async (input) => {
        writes.push(['signup', input]);
        return {};
      },
    },
    $transaction: async (queries) => Promise.all(queries),
  };
}
function token(id, namespace = 'lxl-admin', expires = Date.now() + 60000) {
  const key = createHmac('sha256', secret).update(`${namespace}:session`).digest();
  const payload = `${id}.${expires}`;
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}
function request(id, namespace = 'lxl-admin') {
  return new NextRequest('https://admin.example/api/admin/permissions', {
    headers: { cookie: `lxl_admin_session=${token(id, namespace)}` },
  });
}

test('management login rejects ordinary users and issues independent administrator cookies', async () => {
  const auth = sourceLoader(database())('server/auth.ts');
  for (const username of ['core', 'reviewer', 'admin', 'player']) {
    const response = await auth.signIn(
      new NextRequest('https://admin.example/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password: 'fixture-only' }),
      }),
    );
    assert.equal(response.status, username === 'player' ? 403 : 200);
    const cookie = response.headers.get('set-cookie');
    if (username === 'player') assert.equal(cookie, null);
    else {
      assert.match(cookie, /^lxl_admin_session=/);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /Secure/i);
    }
  }
});

test('database-backed role checks reject non-core admins and user-service sessions', async () => {
  const auth = sourceLoader(database())('server/auth.ts');
  assert.equal((await auth.requireCoreAdmin(request(1))).response, null);
  for (const id of [2, 3, 53])
    assert.equal((await auth.requireCoreAdmin(request(id))).response.status, 403);
  assert.equal(await auth.getSessionUser(request(1, 'lol-champion')), null);
  const oldCookie = new NextRequest('https://admin.example/api/current_user', {
    headers: { cookie: `lxl_session=${token(1)}` },
  });
  assert.equal(await auth.getSessionUser(oldCookie), null);
});

test('Diamond+ writes through the migrated service and updates profile and signup snapshots', async () => {
  const db = database();
  const admin = sourceLoader(db)('server/admin.ts');
  await admin.setUserRank(53, '钻石+', 2);
  assert.equal(db.writes.find(([kind]) => kind === 'profile')[1].update.rank, '钻石+');
  assert.equal(db.writes.find(([kind]) => kind === 'signup')[1].data.rankAtSignup, '钻石+');
  assert.equal(db.writes.find(([kind]) => kind === 'user')[1].data.pendingRank, '');
  db.writes.length = 0;
  await assert.rejects(admin.setUserRank(53, '钻石+', 3), (error) => error.status === 403);
  await assert.rejects(admin.setUserRank(53, 'invented-rank', 1), (error) => error.status === 400);
  assert.equal(db.writes.length, 0);
});

test('deleting a match is denied in the domain layer before any mutation for non-core actors', async () => {
  const db = database();
  const admin = sourceLoader(db)('server/admin.ts');
  for (const actor of [undefined, 2, 3, 53]) {
    await assert.rejects(admin.deleteMatch(1, actor), (error) => error.status === 403);
  }
  assert.equal(db.writes.length, 0);
});

test('CSRF and token checks reject forged, expired and foreign writes', async () => {
  const load = sourceLoader(database());
  const { validManagementToken } = load('lib/session-token.ts');
  assert.equal(await validManagementToken(token(1), secret), true);
  assert.equal(await validManagementToken(token(1, 'lol-champion'), secret), false);
  assert.equal(await validManagementToken(token(1, 'lxl-admin', Date.now() - 100), secret), false);
  const { middleware } = load('middleware.ts');
  for (const site of ['cross-site', 'same-site']) {
    const response = await middleware(
      new NextRequest('https://admin.example/api/admin/users/rank', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'sec-fetch-site': site },
      }),
    );
    assert.equal(response.status, 403);
  }
  assert.equal(
    (await middleware(new NextRequest('https://admin.example/api/admin/users'))).status,
    401,
  );
  assert.equal((await middleware(request(1))).headers.get('x-middleware-next'), '1');
});

test('media paths cannot escape the configured asset root', () => {
  const { safeAssetPath } = sourceLoader(database())('lib/storage-paths.ts');
  for (const segments of [
    ['..', '.env'],
    ['rank', '..'],
    ['.env'],
    ['rank/../../.env'],
    ['rank\\secret'],
  ])
    assert.equal(safeAssetPath('/assets', segments), null);
  assert.ok(safeAssetPath('/assets', ['rank', 'Diamond.png']));
});

test('management shop listing reads shared data without bootstrap or legacy repairs', async () => {
  const existing = [{ id: 7, name: 'existing item' }];
  const db = { shopItem: { findMany: async () => existing } };
  const shop = sourceLoader(db)('server/shop.ts');
  assert.deepEqual(await shop.adminListShopItems(), existing);
});
