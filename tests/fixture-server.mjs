// Contract fixtures for isolated browser tests only. Never imported by application code.
import http from 'node:http';
import { createServer } from 'vite';
import { adminCapabilitySnapshot } from '../src/permissions/catalog.ts';
import { resetDraft, draftRequest, fixtureAudio } from './draft-fixture.mjs';
function actorFor(name) {
  return {
    id: name === 'core' ? 1 : name === 'reviewer' ? 2 : name === 'admin' ? 3 : 4,
    username: name,
    isAdmin: name !== 'member',
    isSecondaryAdmin: name === 'reviewer',
    isCoreAdmin: name === 'core',
  };
}
let users, matches, signups, items, sessions, calls, markets, balances;
function reset() {
  resetDraft();
  sessions = new Map();
  calls = [];
  balances = new Map([
    [7, 100],
    [8, 200],
  ]);
  users = [
    {
      id: 7,
      username: 'test-player',
      status: 'PENDING',
      pendingRank: '',
      isAdmin: false,
      isSecondaryAdmin: false,
      isCoreAdmin: false,
      createdAt: '2026-11-25T02:00:00Z',
      profile: { gameName: '测试选手#0001', rank: '钻石', mainPosition: 'MID' },
    },
    {
      id: 8,
      username: 'approved-player',
      status: 'APPROVED',
      pendingRank: '',
      isAdmin: false,
      createdAt: '2026-11-24T02:00:00Z',
      profile: { gameName: '测试队长#0002', rank: '大师', mainPosition: 'TOP' },
    },
  ];
  matches = [
    {
      id: 1,
      name: '验收测试常规赛',
      status: 'CREATED',
      bo: 'BO3',
      round: '常规赛',
      date: '2026-11-28T11:00:00Z',
      player_count: 20,
      team_count: 4,
      createdByName: 'core',
    },
  ];
  signups = [
    {
      sign_id: 11,
      source: 'match',
      event_id: 1,
      event_name: '验收测试常规赛',
      user_id: 7,
      username: 'test-player',
      game_name: '测试选手#0001',
      rank: '钻石',
      main_pos: 'MID',
      is_waitlisted: false,
      is_captain: false,
    },
    {
      sign_id: 11,
      source: 'season',
      event_id: 2,
      event_name: '验收测试战队赛',
      user_id: 8,
      username: 'approved-player',
      game_name: '测试队长#0002',
      rank: '大师',
      main_pos: 'TOP',
      is_waitlisted: false,
      is_captain: true,
    },
  ];
  items = [
    {
      id: 3,
      code: 'fixture_hero_card',
      icon: '',
      stock: null,
      effectType: 'HERO_PROTECTION_CARD',
      effectJson: '{}',
      groupCode: 'fixture-group',
      eligibleMinUserId: null,
      eligibleMaxUserId: null,
      name: '验收测试道具',
      description: '仅用于自动化验收',
      category: 'ITEM_CARD',
      price: 300,
      enabled: true,
      durationDays: null,
    },
  ];
  markets = ['OPEN', 'CLOSED', 'SETTLED', 'VOID'].map((status, index) => ({
    id: 41 + index,
    matchId: 1,
    seasonMatchId: null,
    marketKind: 'MATCH_WIN',
    roundNo: null,
    teamOneId: 101,
    teamTwoId: 102,
    status,
    createdAt: new Date().toISOString(),
    bettingCloseAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    source: { name: `竞猜验收赛事${index + 1}`, kind: 'REGULAR', pair: '青龙 vs 白虎' },
    outcomes: [
      { id: 1, outcomeKey: 'TEAM_ONE_WIN', label: '青龙', odds: 1.8, prob: 0.5 },
      { id: 2, outcomeKey: 'TEAM_TWO_WIN', label: '白虎', odds: 1.8, prob: 0.5 },
    ],
  }));
}
reset();
const backend = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const q = url.searchParams;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  const send = (data, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  };
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const multipart = req.headers['content-type']?.startsWith('multipart/form-data');
  let body = raw.length && !multipart ? JSON.parse(raw.toString('utf8')) : {};
  if (multipart) {
    const form = await new Request('http://fixture/upload', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] },
      body: raw,
    }).formData();
    const file = form.get('file');
    body = { file: file ? { name: file.name, size: file.size, type: file.type } : null };
  }
  if (path.startsWith('/assets/music/')) {
    res.setHeader('content-type', 'audio/wav');
    res.end(fixtureAudio());
    return;
  }
  if (path.startsWith('/assets/')) {
    res.setHeader('content-type', 'image/png');
    res.end(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    return;
  }
  if (path === '/api/__test/reset') {
    reset();
    send({ ok: true });
    return;
  }
  if (path === '/api/__test/calls') {
    send(calls);
    return;
  }
  if (path === '/api/__test/expire') {
    sessions.clear();
    send({ ok: true });
    return;
  }
  if (path.startsWith('/api/__test/draft-')) {
    draftRequest(req, res, url, body);
    return;
  }
  if (path === '/api/__test/admin-users') {
    users.push(
      {
        id: 9,
        username: 'other-admin',
        isAdmin: true,
        isSecondaryAdmin: false,
        isCoreAdmin: false,
        status: 'APPROVED',
        pendingRank: '',
        banUntil: null,
        profile: { gameName: '管理员#1234', rank: '大师' },
        createdAt: new Date().toISOString(),
      },
      {
        id: 10,
        username: 'protected-core',
        isAdmin: true,
        isSecondaryAdmin: false,
        isCoreAdmin: true,
        status: 'APPROVED',
        pendingRank: '',
        banUntil: null,
        profile: { gameName: '核心#1234', rank: '王者' },
        createdAt: new Date().toISOString(),
      },
    );
    send({ ok: true });
    return;
  }
  if (['POST', 'DELETE'].includes(req.method)) {
    if (
      !req.headers.origin ||
      new URL(req.headers.origin).host !== req.headers['x-forwarded-host'] ||
      ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])
    ) {
      send({ error: '跨站请求已拒绝' }, 403);
      return;
    }
    calls.push({ path: req.url, body });
  }
  const token = /(?:^|; )lxl_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const name = sessions.get(token);
  if (path === '/api/login') {
    if (
      !['core', 'reviewer', 'admin', 'member'].includes(body.username) ||
      body.password !== 'fixture-only'
    ) {
      send({ error: '用户名或密码错误' }, 401);
      return;
    }
    const id = crypto.randomUUID();
    sessions.set(id, body.username);
    res.setHeader('set-cookie', `lxl_session=${id}; Path=/; HttpOnly; SameSite=Lax`);
    send({ ok: true });
    return;
  }
  if (path === '/api/logout') {
    sessions.delete(token);
    res.setHeader('set-cookie', 'lxl_session=; Path=/; HttpOnly; Max-Age=0');
    send({ ok: true });
    return;
  }
  if (path === '/api/current_user') {
    send({
      login: !!name,
      username: name || '',
      is_admin: !!name && name !== 'member',
      is_core_admin: name === 'core',
      is_secondary_admin: name === 'reviewer',
    });
    return;
  }
  if (!name) {
    send({ error: '请先登录' }, 401);
    return;
  }
  if (path === '/api/admin/permissions') {
    if (name === 'member') {
      send({ error: '需要管理员权限' }, 403);
      return;
    }
    send({ ok: true, ...adminCapabilitySnapshot(actorFor(name)) });
    return;
  }
  if (
    name === 'member' ||
    ((path.startsWith('/api/admin/shop') ||
      path.startsWith('/api/admin/markets') ||
      path === '/api/admin/points/recharge') &&
      name !== 'core')
  ) {
    send({ error: '需要管理员权限' }, 403);
    return;
  }
  if (draftRequest(req, res, url, body, matches)) return;
  if (path === '/api/admin/users') {
    const filtered = users.filter(
      (row) =>
        (name === 'core' || !row.isAdmin) &&
        (!q.get('role') ||
          (q.get('role') === 'USER'
            ? !row.isAdmin
            : q.get('role') === 'CORE_ADMIN'
              ? row.isCoreAdmin
              : q.get('role') === 'SECONDARY_ADMIN'
                ? row.isSecondaryAdmin && !row.isCoreAdmin
                : row.isAdmin && !row.isSecondaryAdmin && !row.isCoreAdmin)) &&
        (!q.get('status') || row.status === q.get('status')) &&
        (!q.get('keyword') || row.username.includes(q.get('keyword'))),
    );
    const offset = Number(q.get('page') || 0) * Number(q.get('pageSize') || 10);
    send({
      users: filtered.slice(offset, offset + Number(q.get('pageSize') || 10)),
      total: filtered.length,
      pending_total: users.filter((row) => row.status === 'PENDING').length,
      core_admin_total: 1,
      secondary_admin_total: 1,
      admin_total: 0,
    });
    return;
  }
  if (path === '/api/admin/users/status') {
    users.find((row) => row.id === body.userId).status = body.status;
    send({ msg: '审核状态已更新' });
    return;
  }
  if (path === '/api/admin/users/batch-approve') {
    for (const row of users) if (body.userIds.includes(row.id)) row.status = 'APPROVED';
    send({ msg: '批量审核完成' });
    return;
  }
  const userAction =
    /^\/api\/admin\/users\/(admin|rank|ban|unban|password|game_name|delete\/\d+)$/.exec(path);
  if (userAction) {
    const operation = userAction[1];
    const userId = operation.startsWith('delete/') ? Number(operation.split('/')[1]) : body.userId;
    const target = users.find((user) => user.id === userId);
    if (!target) {
      send({ error: '用户不存在' }, 404);
      return;
    }
    if (
      ((['admin', 'password'].includes(operation) || operation.startsWith('delete/')) &&
        name !== 'core') ||
      (['rank', 'ban', 'unban'].includes(operation) && !['core', 'reviewer'].includes(name)) ||
      (target.isAdmin && name !== 'core')
    ) {
      send({ error: '当前账号无权操作该用户' }, 403);
      return;
    }
    if (operation === 'admin') {
      if (!['USER', 'ADMIN', 'SECONDARY_ADMIN', 'CORE_ADMIN'].includes(body.role)) {
        send({ error: '角色参数无效' }, 400);
        return;
      }
      target.isAdmin = body.role !== 'USER';
      target.isSecondaryAdmin = body.role === 'SECONDARY_ADMIN';
      target.isCoreAdmin = body.role === 'CORE_ADMIN';
    } else if (operation === 'rank') {
      target.profile.rank = body.rank;
      target.pendingRank = '';
    } else if (operation === 'ban') {
      if (target.isCoreAdmin) {
        send({ error: '不能处罚核心管理员' }, 403);
        return;
      }
      if (target.id === 7) {
        send({ error: '该用户已报名未结束赛事，暂时不能处罚' }, 400);
        return;
      }
      target.banUntil = new Date(Date.now() + body.days * 86_400_000).toISOString();
    } else if (operation === 'unban') target.banUntil = null;
    else if (operation === 'game_name') target.profile.gameName = body.gameName;
    else if (operation.startsWith('delete/')) {
      if (target.isCoreAdmin) {
        send({ error: '不能删除核心管理员' }, 403);
        return;
      }
      users = users.filter((user) => user.id !== userId);
      signups = signups.filter((row) => row.user_id !== userId);
    }
    send({ msg: operation === 'password' ? '用户密码已重置为测试初始密码' : '用户操作已完成' });
    return;
  }
  if (path === '/api/match/list') {
    const filtered = matches.filter(
      (row) =>
        (!q.get('status') || row.status === q.get('status')) &&
        (!q.get('keyword') || row.name.includes(q.get('keyword'))),
    );
    send({
      match_list: filtered.slice(0, Number(q.get('pageSize') || 10)),
      total: filtered.length,
    });
    return;
  }
  if (path === '/api/admin/match/create') {
    matches.unshift({
      id: matches.length + 1,
      ...body,
      status: 'CREATED',
      player_count: 0,
      team_count: 0,
      createdByName: name,
    });
    send({ msg: '赛事已创建' });
    return;
  }
  if (path === '/api/admin/sign/list') {
    send({ signup_list: signups });
    return;
  }
  if (path.startsWith('/api/admin/sign/cancel/')) {
    const source = q.get('type') === 'season' ? 'season' : 'match';
    signups = signups.filter(
      (row) => row.sign_id !== Number(path.split('/').pop()) || row.source !== source,
    );
    send({ msg: '报名已取消' });
    return;
  }
  if (path === '/api/admin/season/list') {
    send({
      seasons: [
        {
          id: 2,
          name: '验收测试战队赛',
          status: 'DRAFTING',
          start_date: null,
          team_count: 4,
          signup_count: 20,
          match_count: 6,
        },
      ],
    });
    return;
  }
  if (path === '/api/admin/shop') {
    send({ items });
    return;
  }
  if (path === '/api/admin/shop/upload-icon') {
    if (!body.file?.size) {
      send({ error: '请选择图片文件' }, 400);
      return;
    }
    send({ url: '/assets/shop-icons/fixture-icon.png' });
    return;
  }
  if (path === '/api/admin/shop/create') {
    const id = Math.max(3, ...items.map((item) => item.id)) + 1;
    items.push({
      id,
      ...body,
      code: `fixture-${id}`,
      stock: null,
      enabled: true,
      effectType: 'DECORATION',
      effectJson: JSON.stringify({
        type:
          body.category === 'NAMEPLATE'
            ? 'nameplate'
            : body.category === 'TITLE'
              ? 'title'
              : 'avatar_frame',
        value: body.effectValue || body.icon || 'gold',
      }),
      groupCode: `fixture-${id}`,
    });
    send({ msg: '商品已创建', item_id: id });
    return;
  }
  if (/^\/api\/admin\/shop\/\d+$/.test(path)) {
    const id = Number(path.split('/').pop());
    const item = items.find((item) => item.id === id);
    if (!item) {
      send({ error: '商品不存在' }, 404);
      return;
    }
    if (req.method === 'DELETE') {
      items = items.filter((item) => item.id !== id);
      send({ msg: '商品已删除' });
      return;
    }
    Object.assign(item, body);
    send({ msg: '商品已更新' });
    return;
  }
  if (path === '/api/admin/points/recharge') {
    if (
      !users.some((user) => user.id === body.userId) ||
      !Number.isInteger(body.amount) ||
      body.amount < 1
    ) {
      send({ error: '充值参数无效' }, 400);
      return;
    }
    const balance = (balances.get(body.userId) || 0) + body.amount;
    balances.set(body.userId, balance);
    send({ user_id: body.userId, amount: body.amount, balance, note: body.note?.trim() || '' });
    return;
  }
  if (path === '/api/admin/markets') {
    const pageSize = Number(q.get('pageSize') || 10);
    const filtered = markets.filter(
      (market) =>
        q.get('range') === 'all' ||
        ((!q.get('startDate') ||
          Date.parse(market.createdAt) >= Date.parse(`${q.get('startDate')}T00:00:00+08:00`)) &&
          (!q.get('endDate') ||
            Date.parse(market.createdAt) <
              Date.parse(`${q.get('endDate')}T00:00:00+08:00`) + 86_400_000)),
    );
    const page = Math.min(
      Number(q.get('page') || 1),
      Math.max(1, Math.ceil(filtered.length / pageSize)),
    );
    send({
      markets: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      regular: [
        {
          id: 1,
          name: '竞猜验收常规赛',
          bo: 'BO3',
          date: null,
          status: 'LIVE',
          pairings: [
            { roundNo: 1, teamOneId: 101, teamTwoId: 102, label: '青龙 vs 白虎' },
            { roundNo: 1, teamOneId: 103, teamTwoId: 104, label: '朱雀 vs 玄武' },
          ],
        },
        { id: 9, name: '尚未分队的赛事', bo: 'BO3', date: null, status: 'CREATED', pairings: [] },
      ],
      season: [{ id: 1, name: '竞猜验收战队赛', date: null, status: 'LIVE' }],
    });
    return;
  }
  if (path === '/api/admin/markets/open') {
    if ((body.matchId === undefined) === (body.seasonMatchId === undefined)) {
      send({ error: '必须且只能指定一种赛事来源' }, 400);
      return;
    }
    const existing = markets.find(
      (market) =>
        market.matchId === (body.matchId ?? null) &&
        market.seasonMatchId === (body.seasonMatchId ?? null) &&
        market.teamOneId === (body.teamOneId ?? null) &&
        market.teamTwoId === (body.teamTwoId ?? null) &&
        market.roundNo === (body.roundNo ?? null),
    );
    if (existing && ['SETTLED', 'VOID'].includes(existing.status)) {
      send({ error: '盘口已结算或作废' }, 409);
      return;
    }
    if (existing) {
      existing.status = 'OPEN';
      send({ market_id: existing.id, reused: true });
      return;
    }
    const market = {
      ...structuredClone(markets[0]),
      id: Math.max(...markets.map((m) => m.id)) + 1,
      matchId: body.matchId ?? null,
      seasonMatchId: body.seasonMatchId ?? null,
      teamOneId: body.teamOneId ?? null,
      teamTwoId: body.teamTwoId ?? null,
      roundNo: body.roundNo ?? null,
      marketKind: body.roundNo ? 'GAME_WIN' : 'MATCH_WIN',
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      source: {
        name: body.seasonMatchId ? '新建战队赛盘口' : '新建常规赛盘口',
        kind: body.seasonMatchId ? 'SEASON' : 'REGULAR',
        pair: '青龙 vs 白虎',
      },
    };
    markets.unshift(market);
    send({ market_id: market.id });
    return;
  }
  const marketRoute = /^\/api\/admin\/markets\/(\d+)\/(bets|close|settle|void)$/.exec(path);
  if (marketRoute) {
    const market = markets.find((m) => m.id === Number(marketRoute[1]));
    if (!market) {
      send({ error: '盘口不存在' }, 404);
      return;
    }
    const action = marketRoute[2];
    if (action === 'bets') {
      send({
        market,
        totalPool: 100,
        totalBets: 1,
        outcomes: market.outcomes.map((o, i) => ({
          ...o,
          totalStake: i === 0 ? 100 : 0,
          betCount: i === 0 ? 1 : 0,
        })),
        bets: [
          {
            id: 71,
            userId: 7,
            username: 'test-player',
            gameName: '测试下注选手',
            outcomeLabel: '青龙',
            stake: 100,
            odds_at_bet: 1.8,
            potential_payout: 180,
            settled_payout: market.status === 'SETTLED' ? 180 : market.status === 'VOID' ? 100 : 0,
            status:
              market.status === 'SETTLED' ? 'WON' : market.status === 'VOID' ? 'REFUNDED' : 'OPEN',
            createdAt: new Date().toISOString(),
          },
        ],
      });
      return;
    }
    if (['SETTLED', 'VOID'].includes(market.status)) {
      send({ error: '盘口已结束' }, 409);
      return;
    }
    if (action === 'settle' && !market.outcomes.some((o) => o.outcomeKey === body.winnerKey)) {
      send({ error: '结算选项无效' }, 400);
      return;
    }
    market.status = { close: 'CLOSED', settle: 'SETTLED', void: 'VOID' }[action];
    send({ market_id: market.id });
    return;
  }
  send({ error: '测试接口不存在' }, 404);
});
await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
process.env.BACKEND_ORIGIN = `http://127.0.0.1:${backend.address().port}`;
// Local HTTPS settings may point at a real backend. Test fixtures stay HTTP and isolated.
process.env.DEV_HTTPS_KEY = '';
process.env.DEV_HTTPS_CERT = '';
const vite = await createServer({ server: { port: 5175, host: '127.0.0.1', strictPort: true } });
await vite.listen();
console.log('Isolated acceptance environment: http://127.0.0.1:5175 (fixture data only)');
for (const event of ['SIGINT', 'SIGTERM'])
  process.on(event, async () => {
    await vite.close();
    backend.close();
    process.exit(0);
  });
