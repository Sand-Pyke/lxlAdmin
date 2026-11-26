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
  await post(`/api/admin/match/set_fee/${match.id}`, cookies.core, { useFee: true });
  assert.equal((await db.match.findUnique({ where: { id: match.id } })).useFee, true);

  const customBody = {
    name: 'Custom tournament fixture',
    bo: '自定义赛事',
    custom_team_count: 6,
    round_formats: ['BO5', 'BO1', 'BO3'],
    min_signup_rank: '钻石',
    use_fee: false,
  };
  const invalidCustom = await call('/api/admin/match/create', {
    method: 'POST',
    cookie: cookies.admin,
    body: { ...customBody, round_formats: ['BO5'] },
  });
  assert.equal(invalidCustom.status, 400);
  const { id: editId } = await post('/api/admin/match/create', cookies.admin, {
    name: 'Editable BO3',
    bo: 'BO3',
  });
  const editRoute = `/api/admin/match/update/${editId}`;
  const edited = { ...customBody, name: 'Edited from BO3', date: '2026-11-26T19:30:00+08:00' };
  const rejected = await call(editRoute, {
    method: 'POST',
    cookie: cookies.admin,
    body: { ...edited, round_formats: ['BO5'] },
  });
  assert.equal(rejected.status, 400);
  assert.equal((await db.match.findUnique({ where: { id: editId } })).name, 'Editable BO3');
  await post(editRoute, cookies.admin, edited);
  const editedMatch = await db.match.findUniqueOrThrow({ where: { id: editId } });
  assert.equal(editedMatch.name, edited.name);
  assert.equal(editedMatch.bo, customBody.bo);
  assert.equal(editedMatch.date.toISOString(), '2026-11-26T11:30:00.000Z');
  assert.deepEqual(editedMatch.roundFormats, customBody.round_formats);
  const { id: customId } = await post('/api/admin/match/create', cookies.admin, customBody);
  const customFormatRoute = `/api/admin/match/set_bo/${customId}`;
  await post(customFormatRoute, cookies.admin, { ...customBody, custom_team_count: 8 });
  assert.equal((await db.match.findUnique({ where: { id: customId } })).customTeamCount, 8);
  await post(customFormatRoute, cookies.admin, customBody);
  const board = await (
    await call(`/api/admin/teams/${customId}`, { cookie: cookies.admin })
  ).json();
  assert.equal(board.match.custom_team_count, 6);
  assert.equal(board.match.total_rounds, 3);
  assert.deepEqual(board.match.round_formats, customBody.round_formats);
  assert.equal(board.match.allow_item_cards, true);
  assert.equal(board.match.min_signup_rank, '钻石');
  const incomplete = await call(`/api/admin/match/finish_pick/${customId}`, {
    method: 'POST',
    cookie: cookies.core,
    body: {},
  });
  assert.equal(incomplete.status, 400);
  for (let index = 0; index < 6; index++) {
    await post('/api/admin/team/create', cookies.core, {
      matchId: customId,
      name: `Custom ${index}`,
    });
  }
  const customTeams = await db.team.findMany({
    where: { matchId: customId },
    orderBy: { sortOrder: 'asc' },
  });
  const extraTeam = await call('/api/admin/team/create', {
    method: 'POST',
    cookie: cookies.core,
    body: { matchId: customId, name: 'Extra custom team' },
  });
  assert.equal(extraTeam.status, 400);
  const positions = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'];
  const players = await db.user.createManyAndReturn({
    data: Array.from({ length: 30 }, (_, index) => ({
      username: `custom-player-${index}`,
      passwordHash,
    })),
  });
  await db.matchSignup.createMany({
    data: players.map((user, index) => ({
      matchId: customId,
      userId: user.id,
      teamId: customTeams[Math.floor(index / 5)].id,
      mainPosition: positions[index % 5],
      teamPosition: positions[index % 5],
      rankAtSignup: '钻石',
    })),
  });
  const reserved = await db.heroProtectionCard.create({
    data: { ownerId: players[0].id, awardType: 'SHOP' },
  });
  await db.matchHeroProtection.create({
    data: {
      matchId: customId,
      teamId: customTeams[0].id,
      ownerId: players[0].id,
      cardId: reserved.id,
      heroName: '安妮',
    },
  });
  const consumed = await db.heroProtectionCard.create({
    data: {
      ownerId: players[1].id,
      awardType: 'SHOP',
      usedMatchId: customId,
      consumedAt: new Date(),
    },
  });
  const disable = { ...customBody, allow_item_cards: false };
  const blocked = await call(`/api/admin/match/update/${customId}`, {
    method: 'POST',
    cookie: cookies.admin,
    body: { ...disable, name: 'Rejected name' },
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).msg, /已有道具卡使用记录/);
  assert.equal(
    (await db.match.findUniqueOrThrow({ where: { id: customId } })).name,
    customBody.name,
  );
  assert.equal(await db.matchHeroProtection.count({ where: { matchId: customId } }), 1);
  await db.heroProtectionCard.delete({ where: { id: consumed.id } });
  await post(customFormatRoute, cookies.admin, disable);
  await post(customFormatRoute, cookies.admin, customBody);
  assert.equal((await db.match.findUnique({ where: { id: customId } })).allowItemCards, false);
  assert.equal(await db.matchHeroProtection.count({ where: { matchId: customId } }), 0);
  assert.equal(
    (await db.heroProtectionCard.findUnique({ where: { id: reserved.id } })).consumedAt,
    null,
  );
  await post(`/api/admin/match/finish_pick/${customId}`, cookies.core, {});
  for (let index = 0; index < 6; index += 2) {
    const body = {
      matchId: customId,
      roundNo: 1,
      teamOneId: customTeams[index].id,
      teamTwoId: customTeams[index + 1].id,
      scoreOne: 3,
      scoreTwo: 1,
    };
    await post('/api/admin/match/score', cookies.core, body);
  }
  const noWildcard = await call(`/api/admin/match/round/end/${customId}`, {
    method: 'POST',
    cookie: cookies.core,
    body: { roundNo: 1 },
  });
  assert.equal(noWildcard.status, 400);
  await post(`/api/admin/match/round/end/${customId}`, cookies.core, {
    roundNo: 1,
    wildcardTeamId: customTeams[1].id,
  });
  const semi = await db.matchRound.findMany({ where: { matchId: customId, roundNo: 2 } });
  assert.equal(semi.length, 2);
  const wrongScore = await call('/api/admin/match/score', {
    method: 'POST',
    cookie: cookies.core,
    body: {
      matchId: customId,
      roundNo: 2,
      teamOneId: semi[0].teamOneId,
      teamTwoId: semi[0].teamTwoId,
      scoreOne: 3,
      scoreTwo: 1,
    },
  });
  assert.equal(wrongScore.status, 400);
  console.log(
    'PASS custom tournament validation, team capacity, round formats and six-team wildcard',
  );

  const { id: balancedId } = await post('/api/admin/match/create', cookies.admin, {
    name: 'Balanced draft fixture',
    bo: 'BO3',
  });
  const balancedTeams = await db.team.createManyAndReturn({
    data: Array.from({ length: 4 }, (_, index) => ({
      matchId: balancedId,
      name: `Balanced ${index}`,
    })),
  });
  const adc = ['王者', '大师', '钻石', '翡翠'];
  const support = ['黄金', '钻石', '大师', '大师+'];
  const balancedPlayers = await db.user.createManyAndReturn({
    data: Array.from({ length: 20 }, (_, index) => ({
      username: `balance-player-${index}`,
      passwordHash,
    })),
  });
  const balancedSignups = await db.matchSignup.createManyAndReturn({
    data: balancedPlayers.map((player, index) => {
      const team = Math.floor(index / 5);
      const slot = index % 5;
      const assigned = slot < 3 && index !== 2;
      return {
        matchId: balancedId,
        userId: player.id,
        mainPosition: positions[slot],
        rankAtSignup: ['王者', '黄金', '黄金', adc[team], support[team]][slot],
        teamId: assigned ? balancedTeams[team].id : null,
        teamPosition: assigned ? positions[slot] : '',
        positionOrder: assigned ? slot + 1 : 0,
        isCaptain: slot === 0,
      };
    }),
  });
  const balancedBody = {
    matchId: balancedId,
    balancedDraft: true,
    draftTeamIds: balancedTeams.map((team) => team.id),
  };
  const autoRoute = '/api/admin/team/auto_assign';
  assert.equal(
    (await call(autoRoute, { method: 'POST', cookie: cookies.admin, body: balancedBody })).status,
    400,
  );
  const assignRoute = '/api/admin/team/assign';
  await post(assignRoute, cookies.admin, {
    ...balancedBody,
    signId: balancedSignups[2].id,
    teamId: balancedTeams[0].id,
    teamPosition: 'MID',
  });
  const fourthPick = await call(assignRoute, {
    method: 'POST',
    cookie: cookies.admin,
    body: {
      ...balancedBody,
      signId: balancedSignups[3].id,
      teamId: balancedTeams[0].id,
      teamPosition: 'ADC',
    },
  });
  assert.equal(fourthPick.status, 400);
  const missing = balancedSignups[3];
  await db.matchSignup.update({ where: { id: missing.id }, data: { isWaitlisted: true } });
  assert.equal(
    (await call(autoRoute, { method: 'POST', cookie: cookies.admin, body: balancedBody })).status,
    400,
  );
  assert.equal(
    await db.matchSignup.count({ where: { matchId: balancedId, teamId: { not: null } } }),
    12,
  );
  await db.matchSignup.update({ where: { id: missing.id }, data: { isWaitlisted: false } });
  const completed = await post(autoRoute, cookies.admin, balancedBody);
  assert.equal(completed.assigned, 8);
  assert.match(completed.msg, /最大差 0 分/);
  const balancedBoard = await (
    await call(`/api/admin/teams/${balancedId}`, { cookie: cookies.admin })
  ).json();
  assert.deepEqual(
    balancedBoard.teams.map((team) => [team.player_count, team.used_fee]),
    Array.from({ length: 4 }, () => [5, 21]),
  );
  for (const [index, signup] of balancedSignups.entries()) {
    if (index % 5 >= 3) continue;
    const assigned = balancedBoard.signs.find((sign) => sign.id === signup.id);
    assert.equal(assigned.team_id, balancedTeams[Math.floor(index / 5)].id);
    assert.equal(assigned.team_pos, positions[index % 5]);
  }
  assert.equal((await post(autoRoute, cookies.admin, balancedBody)).assigned, 0);
  console.log(
    'PASS draft 2.0 preserves manual picks, rejects incomplete plans and balances all final teams',
  );
  const season = await post('/api/admin/season/create', cookies.core, { name: 'Fixture season' });
  const seasonId = season.id;
  await db.teamSeason.update({ where: { id: seasonId }, data: { status: 'DRAFTING' } });
  const first = await post('/api/admin/season/team/create', cookies.core, {
    seasonId,
    name: 'Fixture A',
  });
  const second = await post('/api/admin/season/team/create', cookies.core, {
    seasonId,
    name: 'Fixture B',
  });
  await post('/api/admin/season/team/update', cookies.core, {
    teamId: first.id,
    name: 'Fixture A',
    abbr: 'A',
  });
  await db.teamSeasonSignup.createMany({
    data: [target.id, actors.player.id].map((userId) => ({
      seasonId,
      userId,
      mainPosition: 'TOP',
    })),
  });
  await post('/api/admin/season/member/assign', cookies.core, {
    seasonId,
    teamId: first.id,
    userId: target.id,
    role: 'STARTER',
    position: 'TOP',
  });
  await post('/api/admin/season/member/assign', cookies.core, {
    seasonId,
    teamId: first.id,
    userId: actors.player.id,
    role: 'SUB',
    position: 'TOP',
  });
  const planned = await db.teamSeasonMatch.create({
    data: { seasonId, scheduledAt: new Date(), teamOneId: first.id, teamTwoId: second.id },
  });
  await post('/api/admin/season/match/lineup', cookies.core, {
    matchId: planned.id,
    substitutions: [
      { teamId: first.id, starterUserId: target.id, substituteUserId: actors.player.id },
    ],
  });
  assert.equal(await db.teamSeasonMatchSubstitution.count({ where: { matchId: planned.id } }), 1);
  await post('/api/admin/season/match/lineup', cookies.core, {
    matchId: planned.id,
    substitutions: [],
  });
  assert.equal(await db.teamSeasonMatchSubstitution.count({ where: { matchId: planned.id } }), 0);
  await post('/api/admin/season/member/remove', cookies.core, {
    seasonId,
    userId: actors.player.id,
  });
  assert.equal(await db.teamSeasonMember.count({ where: { teamId: first.id } }), 1);

  const comment = await db.communityComment.create({ data: { content: 'Fixture post' } });
  const video = await db.video.create({
    data: {
      title: 'Fixture video',
      objectKey: 'videos/v123_abcd.mp4',
      mimeType: 'video/mp4',
      size: 10,
    },
  });
  for (const route of ['/api/admin/videos', '/api/admin/community']) {
    assert.equal((await call(route)).status, 401);
  }
  const videos = await call('/api/admin/videos?pageSize=1', { cookie: cookies.admin });
  assert.equal(videos.status, 200);
  assert.equal((await videos.json()).videos[0].id, video.id);
  const posts = await call('/api/admin/community?pageSize=1', { cookie: cookies.admin });
  assert.equal(posts.status, 200);
  assert.equal((await posts.json()).posts[0].id, comment.id);
  assert.equal(
    (await call(`/api/admin/community/${comment.id}`, { cookie: cookies.admin, method: 'DELETE' }))
      .status,
    200,
  );
  assert.equal(await db.communityComment.count(), 0);
  console.log(
    'PASS season roster and substitution reset, fee setting, video list and community moderation',
  );
  const deleteRoute = `/api/admin/match/delete/${match.id}`;
  assert.ok(
    (
      await (await call('/api/admin/permissions', { cookie: cookies.reviewer })).json()
    ).permissions.includes('matches.delete'),
  );
  assert.equal(
    (await call(deleteRoute, { method: 'POST', cookie: cookies.admin, body: {} })).status,
    403,
  );
  for (const status of ['LIVE', 'FINISHED']) {
    await db.match.update({ where: { id: match.id }, data: { status } });
    for (const role of ['reviewer', 'core']) {
      assert.equal(
        (await call(deleteRoute, { method: 'POST', cookie: cookies[role], body: {} })).status,
        400,
      );
      assert.ok(await db.match.findUnique({ where: { id: match.id } }));
    }
  }
  await db.match.update({ where: { id: match.id }, data: { status: 'CREATED' } });
  await post(deleteRoute, cookies.reviewer, {});
  assert.equal(await db.match.findUnique({ where: { id: match.id } }), null);
  console.log(
    'PASS real approval, Diamond+ synchronization and secondary admin draft match deletion',
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
  const poolMatch = await db.match.create({
    data: { name: 'Pool fixture', status: 'LIVE', bo: 'BO3' },
  });
  const [poolTeamOne, poolTeamTwo] = await db.team.createManyAndReturn({
    data: [
      { matchId: poolMatch.id, name: 'Pool A', sortOrder: 1 },
      { matchId: poolMatch.id, name: 'Pool B', sortOrder: 2 },
    ],
  });
  const opening = { matchId: poolMatch.id, teamOneId: poolTeamOne.id, teamTwoId: poolTeamTwo.id };
  const { market_id: poolId } = await post('/api/admin/markets/open', cookies.core, opening);
  const { market_id: oneSidedId } = await post('/api/admin/markets/open', cookies.core, {
    ...opening,
    roundNo: 1,
  });
  assert.equal(
    (await db.matchMarket.findUniqueOrThrow({ where: { id: poolId } })).pricingMode,
    'POOL',
  );
  const poolOutcomes = await db.marketOutcome.findMany({
    where: { marketId: poolId },
    orderBy: { outcomeKey: 'asc' },
  });
  const [poolBettorA, poolBettorB, poolBettorC, poolBettorD] = await db.user.createManyAndReturn({
    data: ['poolA', 'poolB', 'poolC', 'poolD'].map((username) => ({ username, passwordHash })),
  });
  function addPoolBet(marketId, outcomeId, userId, stake) {
    return db.bet.create({
      data: { marketId, outcomeId, userId, stake, oddsAtBet: 1, potentialPayout: stake },
    });
  }
  await addPoolBet(poolId, poolOutcomes[0].id, poolBettorA.id, 100);
  await addPoolBet(poolId, poolOutcomes[1].id, poolBettorB.id, 100);
  const poolDetail = `/api/admin/markets/${poolId}/bets`;
  const readPool = async () => (await call(poolDetail, { cookie: cookies.core })).json();
  assert.deepEqual(
    (await readPool()).outcomes.map((o) => o.odds),
    [1.9, 1.9],
  );
  await addPoolBet(poolId, poolOutcomes[0].id, poolBettorC.id, 400);
  assert.deepEqual(
    (await readPool()).outcomes.map((o) => o.odds),
    [1.18, 5.5],
  );
  await post(`/api/admin/markets/${poolId}/close`, cookies.core, {});
  assert.equal((await readPool()).market.status, 'CLOSED');
  assert.deepEqual(
    (await readPool()).bets.map((o) => o.potential_payout),
    [472, 550, 118],
  );
  await post(`/api/admin/markets/${poolId}/settle`, cookies.core, { winnerKey: 'TEAM_ONE_WIN' });
  assert.equal(
    (await db.pointWallet.findUniqueOrThrow({ where: { userId: poolBettorC.id } })).balance,
    472,
  );
  const oneSided = await db.marketOutcome.findFirstOrThrow({ where: { marketId: oneSidedId } });
  await addPoolBet(oneSidedId, oneSided.id, poolBettorB.id, 500);
  await db.matchMarket.update({ where: { id: oneSidedId }, data: { bettingCloseAt: new Date(0) } });
  const closeByDeadline = await call(`/api/admin/markets/${oneSidedId}/bets`, {
    cookie: cookies.core,
  });
  const refunded = await closeByDeadline.json();
  assert.equal(refunded.market.status, 'VOID');
  assert.equal(refunded.market.voidReason, 'NO_OPPOSITION');
  assert.equal(refunded.bets[0].settled_payout, 500);
  assert.equal(
    (await db.pointWallet.findUniqueOrThrow({ where: { userId: poolBettorB.id } })).balance,
    500,
  );
  await call('/api/admin/markets/' + oneSidedId + '/bets', { cookie: cookies.core });
  assert.equal(
    await db.pointTransaction.count({
      where: { userId: poolBettorB.id, refId: oneSidedId, type: 'BET_REFUND' },
    }),
    1,
  );
  for (const [roundNo, reason, stake] of [
    [2, 'INSUFFICIENT_POOL', 49],
    [3, 'ODDS_LIMIT', 50],
  ]) {
    const { market_id: guardedId } = await post('/api/admin/markets/open', cookies.core, {
      ...opening,
      roundNo,
    });
    const [first, second] = await db.marketOutcome.findMany({
      where: { marketId: guardedId },
      orderBy: { outcomeKey: 'asc' },
    });
    await addPoolBet(guardedId, first.id, poolBettorA.id, 500);
    await addPoolBet(guardedId, second.id, poolBettorB.id, stake);
    if (reason === 'ODDS_LIMIT') {
      await addPoolBet(guardedId, first.id, poolBettorC.id, 500);
      await addPoolBet(guardedId, first.id, poolBettorD.id, 100);
    }
    const closeResult = await post(`/api/admin/markets/${guardedId}/close`, cookies.core, {});
    assert.equal(closeResult.voided, true);
    assert.equal(
      (await db.matchMarket.findUniqueOrThrow({ where: { id: guardedId } })).voidReason,
      reason,
    );
    const refunds = await db.bet.findMany({ where: { marketId: guardedId } });
    assert.ok(refunds.every((bet) => bet.status === 'REFUNDED' && bet.settledPayout === bet.stake));
  }
  console.log(
    'PASS pool odds freeze at close and refund when either side is too small or the quote exceeds the cap',
  );
  const final = await db.match.create({
    data: { name: 'Fixture final', status: 'LIVE', bo: 'BO1', prizePoolJson: '{"1":100,"2":60}' },
  });
  const [finalOne, finalTwo] = await db.team.createManyAndReturn({
    data: [
      { matchId: final.id, name: 'Final A', sortOrder: 1 },
      { matchId: final.id, name: 'Final B', sortOrder: 2 },
    ],
  });
  const finalists = [
    { matchId: final.id, teamId: finalOne.id, userId: target.id },
    { matchId: final.id, teamId: finalTwo.id, userId: actors.player.id },
  ];
  await db.matchSignup.createMany({ data: finalists });
  await db.matchGameRecord.createMany({
    data: finalists.map((sign, index) => ({
      ...sign,
      champion: 'Fixture',
      result: index === 0 ? 'win' : 'lose',
    })),
  });
  const market = {
    matchId: final.id,
    matchRoundNo: 1,
    teamOneId: finalOne.id,
    teamTwoId: finalTwo.id,
    bettingCloseAt: new Date(),
  };
  const seriesMarket = await db.matchMarket.create({ data: market });
  const unplayedMarket = await db.matchMarket.create({
    data: { ...market, marketKind: 'GAME_WIN', roundNo: 2 },
  });
  const win = await db.marketOutcome.create({
    data: { marketId: seriesMarket.id, outcomeKey: 'TEAM_ONE_WIN', label: 'Final A' },
  });
  const loss = await db.marketOutcome.create({
    data: { marketId: seriesMarket.id, outcomeKey: 'TEAM_TWO_WIN', label: 'Final B' },
  });
  const refund = await db.marketOutcome.create({
    data: { marketId: unplayedMarket.id, outcomeKey: 'TEAM_ONE_WIN' },
  });
  await db.bet.createMany({
    data: [
      {
        marketId: seriesMarket.id,
        outcomeId: win.id,
        userId: target.id,
        stake: 15,
        potentialPayout: 30,
      },
      {
        marketId: seriesMarket.id,
        outcomeId: win.id,
        userId: target.id,
        stake: 25,
        potentialPayout: 50,
      },
      {
        marketId: seriesMarket.id,
        outcomeId: loss.id,
        userId: actors.player.id,
        stake: 10,
        potentialPayout: 20,
      },
      {
        marketId: unplayedMarket.id,
        outcomeId: refund.id,
        userId: target.id,
        stake: 15,
        potentialPayout: 30,
      },
      {
        marketId: unplayedMarket.id,
        outcomeId: refund.id,
        userId: target.id,
        stake: 25,
        potentialPayout: 50,
      },
    ].map((bet) => ({ ...bet, oddsAtBet: 2 })),
  });
  const score = {
    matchId: final.id,
    roundNo: 1,
    teamOneId: finalOne.id,
    teamTwoId: finalTwo.id,
    scoreOne: 1,
    scoreTwo: 0,
  };
  await db.pointWallet.update({
    where: { userId: target.id },
    data: { balance: 2147483647 },
  });
  const failedScore = await call('/api/admin/match/score', {
    method: 'POST',
    cookie: cookies.core,
    body: score,
  });
  assert.equal(failedScore.status, 500);
  assert.equal(await db.matchScore.count({ where: { matchId: final.id } }), 0);
  assert.equal(await db.bet.count({ where: { marketId: seriesMarket.id, status: 'OPEN' } }), 3);
  assert.equal(await db.pointTransaction.count({ where: { userId: target.id } }), 1);
  await db.pointWallet.update({ where: { userId: target.id }, data: { balance: 50 } });
  await post('/api/admin/match/score', cookies.core, score);
  await post('/api/admin/match/score', cookies.core, score);
  const settled = await db.bet.findMany({
    where: { marketId: { in: [seriesMarket.id, unplayedMarket.id] } },
    orderBy: { id: 'asc' },
  });
  assert.deepEqual(
    settled.map((bet) => [bet.status, bet.settledPayout]),
    [
      ['WON', 30],
      ['WON', 50],
      ['LOST', 0],
      ['REFUNDED', 15],
      ['REFUNDED', 25],
    ],
  );
  assert.equal(
    await db.userNotification.count({
      where: { type: 'BET_RESULT', userId: { in: finalists.map((sign) => sign.userId) } },
    }),
    3,
  );
  const ended = await post(`/api/admin/match/round/end/${final.id}`, cookies.core, { roundNo: 1 });
  assert.equal(ended.finished, true);
  assert.equal(ended.warning, undefined);
  assert.equal(
    (await db.match.findUniqueOrThrow({ where: { id: final.id } })).prizeDistributed,
    true,
  );
  await post(`/api/admin/match/round/end/${final.id}`, cookies.core, { roundNo: 1 });
  const ledger = await db.pointTransaction.findMany({
    where: { userId: target.id, type: { in: ['BET_WIN', 'BET_REFUND', 'PRIZE_GRANT'] } },
    orderBy: { id: 'asc' },
  });
  assert.deepEqual(
    ledger.map(({ type, amount, balanceAfter }) => [type, amount, balanceAfter]),
    [
      ['BET_WIN', 30, 80],
      ['BET_WIN', 50, 130],
      ['BET_REFUND', 15, 145],
      ['BET_REFUND', 25, 170],
      ['PRIZE_GRANT', 100, 270],
    ],
  );
  const wallet = await db.pointWallet.findUniqueOrThrow({ where: { userId: target.id } });
  assert.deepEqual([wallet.balance, wallet.totalEarned], [270, 270]);
  assert.equal(
    (await db.pointWallet.findUniqueOrThrow({ where: { userId: actors.player.id } })).balance,
    60,
  );
  assert.equal(await db.userNotification.count({ where: { type: 'PRIZE_GRANT' } }), 2);
  const finalRecords = await db.matchGameRecord.findMany({ where: { matchId: final.id } });
  assert.equal(finalRecords.find((record) => record.teamId === finalOne.id)?.teamRank, 1);
  assert.equal(finalRecords.find((record) => record.teamId === finalTwo.id)?.teamRank, 2);
  console.log(
    'PASS score settlement rollback, repeated payouts for the same wallet, refunds, final ranks and prize idempotency',
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
