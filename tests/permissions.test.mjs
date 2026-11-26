import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can } from '../src/permissions/access.ts';
import { loadSession } from '../src/api/session.ts';
import { userActionRequest } from '../src/api/user-actions.ts';

const actor = {
  id: 1,
  username: 'actor',
  login: true,
  is_admin: true,
  is_secondary_admin: false,
  is_core_admin: false,
};
const target = {
  id: 8,
  username: 'target',
  isAdmin: false,
  isSecondaryAdmin: false,
  isCoreAdmin: false,
};
test('permissions combine role ceiling, explicit grants and target-account boundaries', () => {
  assert.ok(can(actor, 'users.review', target));
  assert.ok(!can(actor, 'users.rank.update', target));
  const secondary = { ...actor, is_secondary_admin: true };
  assert.ok(can(secondary, 'matches.delete'));
  assert.ok(!can(actor, 'matches.delete'));
  assert.ok(can(secondary, 'users.ban', target));
  assert.ok(!can(secondary, 'users.ban', { ...target, isAdmin: true }));
  const core = { ...actor, is_core_admin: true };
  assert.ok(can(core, 'users.role.assign', target));
  assert.ok(!can(core, 'users.role.assign', { ...target, id: 1 }));
  assert.ok(!can(core, 'users.delete', { ...target, isCoreAdmin: true, isAdmin: true }));
  assert.ok(!can({ ...core, permissions: [] }, 'shop.delete'));
  assert.ok(!can({ ...actor, permissions: ['users.role.assign'] }, 'users.role.assign'));
});
test('legacy fallback is allowed only on a missing permission endpoint, never denials or outages', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (path) =>
    path === '/api/current_user'
      ? Response.json(actor)
      : Response.json({ error: 'not found' }, { status: 404 });
  assert.equal((await loadSession()).permissionSource, 'legacy');
  for (const status of [403, 500]) {
    globalThis.fetch = async (path) =>
      path === '/api/current_user'
        ? Response.json(actor)
        : Response.json({ error: 'denied' }, { status });
    await assert.rejects(loadSession(), (error) => error.status === status);
  }
  globalThis.fetch = async (path) =>
    path === '/api/current_user'
      ? Response.json(actor)
      : Response.json({ version: 1, user_id: 1, username: 'someone-else', permissions: [] });
  await assert.rejects(loadSession(), /权限数据格式异常/);
});
test('user action payloads match existing POST endpoints and validate destructive confirmations', () => {
  assert.deepEqual(userActionRequest('role', target, { role: 'CORE_ADMIN' }), {
    path: '/api/admin/users/admin',
    body: { userId: 8, role: 'CORE_ADMIN' },
  });
  assert.deepEqual(userActionRequest('rank', target, { rank: '' }).body, { userId: 8, rank: '' });
  assert.deepEqual(userActionRequest('delete', target, { confirmation: 'target' }), {
    path: '/api/admin/users/delete/8',
    body: { userId: 8 },
  });
  assert.throws(
    () => userActionRequest('delete', target, { confirmation: 'other' }),
    /完整用户账号/,
  );
  assert.throws(() => userActionRequest('role', target, { role: 'OWNER' }), /有效角色/);
  assert.throws(() => userActionRequest('ban', target, { days: 0 }), /处罚天数/);
});
