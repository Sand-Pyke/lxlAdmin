// Real API + real PostgreSQL in an isolated temporary cluster. Never uses DATABASE_URL.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const binary =
  process.env.PG_BIN_DIR ||
  (process.platform === 'win32'
    ? 'C:/Program Files/PostgreSQL/18/bin'
    : '/usr/lib/postgresql/18/bin');
const executable = (name) => path.join(binary, name + (process.platform === 'win32' ? '.exe' : ''));
if (!fs.existsSync(executable('initdb')))
  throw new Error('Set PG_BIN_DIR to a PostgreSQL installation with initdb and pg_ctl');
const output = path.resolve(root, '../output');
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(output, 'admin-api-fixture-'));
const cluster = path.join(temporary, 'postgres');
const assets = path.join(temporary, 'assets');
fs.mkdirSync(path.join(assets, 'music'), { recursive: true });
fs.writeFileSync(path.join(assets, 'music/fixture.mp3'), Buffer.from('0123456789'));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const dbPort = await freePort();
const apiPort = await freePort();
const databaseUrl = `postgresql://lxl_fixture@127.0.0.1:${dbPort}/postgres?connect_timeout=2&pool_timeout=2`;
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  ADMIN_SESSION_SECRET: randomBytes(48).toString('hex'),
  ASSET_DIR: assets,
  UPLOAD_DIR: path.join(temporary, 'uploads'),
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
};
for (const key of Object.keys(env)) if (key.startsWith('OSS_')) delete env[key];
const log = fs.openSync(path.join(temporary, 'api.log'), 'a');
function run(command, args, options = {}) {
  // File descriptors avoid inherited-pipe hangs when pg_ctl starts PostgreSQL on Windows.
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', log, log],
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} failed: ${result.error || ''}\n${fs.readFileSync(path.join(temporary, 'api.log'), 'utf8').slice(-5000)}`,
    );
}
let databaseRunning = false;
let service;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const base = `http://127.0.0.1:${apiPort}`;
async function call(route, { cookie, method = 'GET', body, headers = {} } = {}) {
  return fetch(base + route, {
    method,
    headers: {
      'x-forwarded-host': 'admin.fixture',
      'x-forwarded-proto': 'https',
      ...(cookie ? { cookie } : {}),
      ...(body
        ? {
            'content-type': 'application/json',
            origin: 'https://admin.fixture',
            'sec-fetch-site': 'same-origin',
          }
        : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
}
async function post(route, cookie, body) {
  const response = await call(route, { cookie, method: 'POST', body });
  const json = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(json)}`);
  return json;
}
try {
  run(executable('initdb'), [
    '-D',
    cluster,
    '-U',
    'lxl_fixture',
    '-A',
    'trust',
    '-E',
    'UTF8',
    '--locale=C',
    '--no-sync',
  ]);
  run(executable('pg_ctl'), [
    '-D',
    cluster,
    '-l',
    path.join(temporary, 'postgres.log'),
    '-o',
    `-p ${dbPort} -h 127.0.0.1`,
    '-w',
    'start',
  ]);
  databaseRunning = true;
  run(process.execPath, [
    'node_modules/prisma/build/index.js',
    'db',
    'push',
    '--schema',
    'prisma/schema.prisma',
    '--skip-generate',
  ]);
  const passwordHash = await bcrypt.hash('fixture-only', 4);
  const actors = {};
  for (const [username, role] of [
    ['core', 'core'],
    ['reviewer', 'secondary'],
    ['admin', 'admin'],
    ['player', 'user'],
  ]) {
    actors[username] = await db.user.create({
      data: {
        username,
        passwordHash,
        isAdmin: role !== 'user',
        isSecondaryAdmin: role === 'secondary',
        isCoreAdmin: role === 'core',
      },
    });
  }
  const target = await db.user.create({
    data: {
      username: 'target',
      passwordHash,
      status: 'PENDING',
      profile: { create: { name: 'Fixture player', gameName: 'Fixture#1234', rank: '钻石' } },
    },
  });
  service = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(apiPort),
    ],
    { cwd: root, env, stdio: ['ignore', log, log] },
  );
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (service.exitCode !== null)
      throw new Error(
        `Backend exited: ${fs.readFileSync(path.join(temporary, 'api.log'), 'utf8')}`,
      );
    try {
      if ((await call('/healthz')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'Backend did not start');
  assert.equal((await call('/api/health')).status, 200);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'migration-manifest.json'), 'utf8'));
  const publicRoutes = ['/api/login', '/api/logout', '/api/current_user', '/api/health'];
  for (const route of manifest.routes) {
    const pathname = '/' + route.replace(/\[[^\]]+\]/g, '1');
    if (!publicRoutes.includes(pathname))
      assert.equal((await call(pathname)).status, 401, pathname);
  }
  console.log(`PASS anonymous access denied across ${manifest.routes.length} migrated route paths`);
  const cookies = {};
  for (const username of ['core', 'reviewer', 'admin', 'player']) {
    const response = await call('/api/login', {
      method: 'POST',
      body: { username, password: 'fixture-only' },
    });
    assert.equal(response.status, username === 'player' ? 403 : 200);
    if (username === 'player') assert.equal(response.headers.get('set-cookie'), null);
    else {
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie, /^__Host-lxl_admin_session=/);
      assert.match(cookie, /Secure/i);
      assert.match(cookie, /HttpOnly/i);
      cookies[username] = cookie.split(';')[0];
      const permissions = await (
        await call('/api/admin/permissions', { cookie: cookies[username] })
      ).json();
      assert.equal(permissions.username, username);
    }
  }
  console.log('PASS administrator login, independent secure cookies and permission snapshots');
  await post('/api/admin/users/status', cookies.core, { userId: target.id, status: 'APPROVED' });
  const match = await post('/api/admin/match/create', cookies.admin, {
    name: 'Isolated migration fixture',
    bo: 'BO3',
    use_fee: false,
  });
  await db.matchSignup.create({
    data: { userId: target.id, matchId: match.id, rankAtSignup: '钻石' },
  });
  const deniedRank = await call('/api/admin/users/rank', {
    method: 'POST',
    cookie: cookies.admin,
    body: { userId: target.id, rank: '钻石+' },
  });
  assert.equal(deniedRank.status, 403);
  await post('/api/admin/users/rank', cookies.reviewer, { userId: target.id, rank: '钻石+' });
  assert.equal((await db.playerProfile.findUnique({ where: { userId: target.id } })).rank, '钻石+');
  assert.equal(
    (await db.matchSignup.findFirst({ where: { userId: target.id } })).rankAtSignup,
    '钻石+',
  );
  const waiting = await db.matchSignup.create({
    data: { userId: actors.player.id, matchId: match.id, isWaitlisted: true },
  });
  const draftResponse = await call(`/api/admin/pick/${match.id}?live=1`, { cookie: cookies.core });
  assert.equal(draftResponse.status, 200);
  const draft = await draftResponse.json();
  assert.deepEqual(
    draft.board.signs.map((sign) => sign.user_id),
    [target.id],
  );
  assert.equal(draft.signs.find((sign) => sign.id === waiting.id)?.is_waitlisted, true);
  const draftWithStats = await call(`/api/admin/pick/${match.id}`, { cookie: cookies.core });
  assert.equal(draftWithStats.status, 200);
  assert.equal((await draftWithStats.json()).leaderboard_ready, true);
  for (const role of ['admin', 'reviewer'])
    assert.equal(
      (
        await call(`/api/admin/match/delete/${match.id}`, {
          method: 'POST',
          cookie: cookies[role],
          body: {},
        })
      ).status,
      403,
    );
  assert.ok(await db.match.findUnique({ where: { id: match.id } }));
  await post(`/api/admin/match/delete/${match.id}`, cookies.core, {});
  assert.equal(await db.match.findUnique({ where: { id: match.id } }), null);
  console.log(
    'PASS real approval, Diamond+ profile/signup synchronization and core-only match deletion',
  );
  for (const route of ['/api/admin/shop', '/api/admin/markets']) {
    assert.equal((await call(route, { cookie: cookies.core })).status, 200);
    assert.equal((await call(route, { cookie: cookies.admin })).status, 403);
  }
  assert.equal(
    (
      await call('/api/admin/points/recharge', {
        method: 'POST',
        cookie: cookies.admin,
        body: { userId: target.id, amount: 50 },
      })
    ).status,
    403,
  );
  const recharge = await post('/api/admin/points/recharge', cookies.core, {
    userId: target.id,
    amount: 50,
    note: 'Isolated migration verification',
  });
  assert.equal(recharge.balance, 50);
  assert.equal(await db.pointTransaction.count({ where: { userId: target.id } }), 1);
  assert.equal(
    await db.userNotification.count({ where: { userId: target.id, type: 'POINT_RECHARGE' } }),
    1,
  );
  const sponsor = await post('/api/admin/sponsors', cookies.core, {
    userId: target.id,
    amount: 12.5,
  });
  assert.equal(
    (
      await call(`/api/admin/sponsors/${sponsor.id}`, {
        method: 'DELETE',
        cookie: cookies.core,
        headers: { origin: 'https://admin.fixture' },
      })
    ).status,
    200,
  );
  console.log(
    'PASS core-only shop/markets and transactional recharge ledger/notification, sponsor CRUD',
  );
  const csrf = await call('/api/admin/users/rank', {
    method: 'POST',
    cookie: cookies.core,
    body: { userId: target.id, rank: '黄金' },
    headers: { origin: 'https://evil.fixture', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(csrf.status, 403);
  assert.equal((await db.playerProfile.findUnique({ where: { userId: target.id } })).rank, '钻石+');
  const audio = await call('/assets/music/fixture.mp3', { headers: { range: 'bytes=2-4' } });
  assert.equal(audio.status, 206);
  assert.equal(await audio.text(), '234');
  const music = await (await call('/api/admin/draft/music', { cookie: cookies.core })).json();
  assert.equal(music.tracks[0].src, '/assets/music/fixture.mp3');
  await post('/api/logout', cookies.core, {});
  assert.equal((await (await call('/api/current_user')).json()).login, false);
  console.log('PASS CSRF protection, independent music catalogue/range serving and logout');
  fs.writeFileSync(
    path.join(temporary, 'result.json'),
    JSON.stringify(
      { status: 'passed', routeCount: manifest.routes.length, source: manifest.sourceCommit },
      null,
      2,
    ),
  );
  console.log(`Isolated verification complete: ${temporary}`);
} finally {
  if (service && service.exitCode === null) {
    service.kill();
    await new Promise((resolve) => {
      service.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
  }
  await db.$disconnect();
  if (databaseRunning) run(executable('pg_ctl'), ['-D', cluster, '-m', 'fast', '-w', 'stop']);
  fs.closeSync(log);
}
