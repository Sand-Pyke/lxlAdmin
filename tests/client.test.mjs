import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, post, params, ApiError } from '../src/api/client.ts';

test('API client exposes backend errors, rejects HTML fallbacks, and keeps credentials same-origin', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let received;
  globalThis.fetch = async (_path, options) => {
    received = options;
    return Response.json({ msg: '已提交' });
  };
  assert.deepEqual(await post('/api/admin/users/status', { userId: 7, status: 'APPROVED' }), {
    msg: '已提交',
  });
  assert.equal(received.credentials, 'same-origin');
  assert.equal(received.redirect, 'error');
  assert.equal(received.body, '{"userId":7,"status":"APPROVED"}');
  globalThis.fetch = async () => Response.json({ error: '需要核心管理员权限' }, { status: 403 });
  await assert.rejects(
    request('/api/admin/shop'),
    (error) =>
      error instanceof ApiError && error.status === 403 && error.message === '需要核心管理员权限',
  );
  globalThis.fetch = async () =>
    new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(request('/api/current_user'), /返回格式异常/);
  globalThis.fetch = async () => {
    throw new TypeError('network error');
  };
  await assert.rejects(request('/api/current_user'), /无法连接业务服务/);
  await assert.rejects(request('https://evil.invalid/api/login'), /必须以/);
  assert.equal(params({ page: 0, keyword: 'a&b', status: '' }), 'page=0&keyword=a%26b');
});
