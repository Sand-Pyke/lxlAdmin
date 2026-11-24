import { test, expect, type Page } from '@playwright/test';
async function login(page: Page, name = 'core') {
  await page.goto('/users');
  await page.getByLabel('管理员账号').fill(name);
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
}
const row = (page: Page, name = 'approved-player') =>
  page.getByRole('row').filter({ hasText: name });
test.beforeEach(async ({ request }) => {
  await request.get('/api/__test/reset');
});
test('core can assign every admin tier, reset rank/password, penalize, unban and delete with exact confirmation', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const dialog = page.getByRole('dialog');
  for (const role of ['普通管理员', '二级管理员', '核心管理员', '普通用户（取消管理员）']) {
    await row(page).getByRole('button', { name: '设置角色', exact: true }).click();
    await dialog.getByLabel('目标角色', { exact: true }).click();
    await page.getByRole('option', { name: role, exact: true }).click();
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await row(page).getByRole('button', { name: '重置段位', exact: true }).click();
  await dialog.getByLabel('目标段位', { exact: true }).click();
  await page.getByRole('option', { name: '黄金', exact: true }).click();
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(row(page)).toContainText('黄金');
  await row(page).getByRole('button', { name: '处罚用户', exact: true }).click();
  await dialog.getByLabel('处罚天数').fill('3');
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(row(page)).toContainText('处罚中');
  await row(page).getByRole('button', { name: '解除处罚', exact: true }).click();
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(row(page).getByText('处罚中', { exact: true })).toHaveCount(0);
  await row(page).getByRole('button', { name: '重置密码', exact: true }).click();
  await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(dialog).toBeHidden();
  await row(page).getByRole('button', { name: '删除用户', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除用户', exact: true }).click();
  await expect(dialog.getByText('输入的账号不一致')).toBeVisible();
  await dialog.getByLabel('输入用户账号确认删除').fill('approved-player');
  await dialog.getByRole('button', { name: '确认删除用户', exact: true }).click();
  await expect(row(page)).toHaveCount(0);
  const calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls
      .filter((call: { path: string }) => call.path === '/api/admin/users/admin')
      .map((call: { body: { role: string } }) => call.body.role),
  ).toEqual(['ADMIN', 'SECONDARY_ADMIN', 'CORE_ADMIN', 'USER']);
  expect(
    calls.find((call: { path: string }) => call.path === '/api/admin/users/delete/8'),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
test('ordinary and secondary admins get only their permitted user actions', async ({ page }) => {
  await login(page, 'admin');
  await expect(row(page).getByRole('button', { name: '设置角色' })).toHaveCount(0);
  await expect(row(page).getByRole('button', { name: '处罚用户' })).toHaveCount(0);
  await expect(row(page).getByRole('button', { name: '修改游戏 ID' })).toBeVisible();
});
test('secondary admin can reset rank but cannot delete users or reset passwords', async ({
  page,
  request,
}) => {
  await request.get('/api/__test/admin-users');
  await login(page, 'reviewer');
  await expect(row(page).getByRole('button', { name: '重置段位' })).toBeVisible();
  await expect(row(page).getByRole('button', { name: '删除用户' })).toHaveCount(0);
  await expect(row(page).getByRole('button', { name: '重置密码' })).toHaveCount(0);
  await expect(row(page, 'other-admin')).toHaveCount(0);
});
test('core-account boundaries and state-related server denials remain in force', async ({
  page,
  request,
}) => {
  await request.get('/api/__test/admin-users');
  await login(page);
  await expect(row(page, 'protected-core').getByRole('button', { name: '删除用户' })).toHaveCount(
    0,
  );
  await expect(row(page, 'protected-core').getByRole('button', { name: '处罚用户' })).toHaveCount(
    0,
  );
  await row(page, 'test-player').getByRole('button', { name: '处罚用户' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认执行' }).click();
  await expect(
    page.getByRole('dialog').getByText('该用户已报名未结束赛事，暂时不能处罚'),
  ).toBeVisible();
});
test('server permissions hide individual buttons and protect direct module routes', async ({
  page,
}) => {
  await page.route('**/api/admin/permissions', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.permissions = data.permissions.filter(
      (permission: string) =>
        !['users.delete', 'users.role.assign', 'shop.view', 'shop.delete'].includes(permission),
    );
    await route.fulfill({ response, json: data });
  });
  await login(page);
  await expect(row(page).getByRole('button', { name: '删除用户' })).toHaveCount(0);
  await expect(row(page).getByRole('button', { name: '设置角色' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '商品管理' })).toHaveCount(0);
  await page.goto('/shop');
  await expect(page.getByText('暂无管理权限', { exact: true })).toBeVisible();
});
test('old backend without the permission endpoint still supports role-scoped operations', async ({
  page,
}) => {
  await page.route('**/api/admin/permissions', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );
  await login(page, 'reviewer');
  await expect(row(page).getByRole('button', { name: '重置段位' })).toBeVisible();
  await expect(row(page).getByRole('button', { name: '设置角色' })).toHaveCount(0);
});
