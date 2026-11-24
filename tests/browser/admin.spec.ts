import { test, expect, type Page } from '@playwright/test';

async function signIn(page: Page, username = 'core') {
  await page.goto('/login');
  await page.getByLabel('管理员账号').fill(username);
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
test.beforeEach(async ({ request }) => {
  await request.get('/api/__test/reset');
});

test('login, review, create match, cancel correct signup source, toggle shop, logout', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page);
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await expect(page.getByRole('cell').filter({ hasText: '验收测试常规赛' })).toBeVisible();
  await expect(page.locator('.ant-spin-blur')).toHaveCount(0);
  await page.screenshot({
    path: 'output/dashboard-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('link', { name: /审核新账号/ }).click();
  await expect(page.getByText('测试选手#0001')).toBeVisible();
  await expect(page.getByText('测试队长#0002')).toHaveCount(0);
  await page.getByRole('button', { name: '通过', exact: true }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByText('测试选手#0001')).toHaveCount(0);
  await page.getByRole('menuitem', { name: '常规赛事' }).click();
  await page.getByRole('button', { name: '创建常规赛', exact: true }).click();
  await page.getByLabel('赛事名称', { exact: true }).fill('自动验收新赛事');
  await page.getByLabel('排期时间（北京时间）').fill('2026-12-01T19:00');
  await page.getByRole('button', { name: '创建赛事', exact: true }).click();
  await expect(page.getByRole('cell').filter({ hasText: '自动验收新赛事' })).toBeVisible();
  const calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.find((call: { path: string }) => call.path === '/api/admin/match/create').body.date,
  ).toBe('2026-12-01T19:00:00+08:00');
  await page.getByRole('menuitem', { name: '报名管理' }).click();
  const seasonRow = page.getByRole('row').filter({ hasText: '验收测试战队赛' });
  await seasonRow.getByRole('button', { name: '取消报名' }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '验收测试战队赛' })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: '验收测试常规赛' })).toHaveCount(1);
  await page.getByRole('menuitem', { name: '商品管理' }).click();
  await page.getByRole('button', { name: '下架', exact: true }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByText('已下架', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /core/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('heading', { name: '登录管理平台' })).toBeVisible();
  await page.goto('/users?status=PENDING');
  await expect(page).toHaveURL(/\/login$/);
  expect(errors).toEqual([]);
});

test('lower admin role cannot open core-only routes; session expiration hides private pages', async ({
  page,
  request,
}) => {
  await signIn(page, 'reviewer');
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '商品管理' })).toHaveCount(0);
  await page.goto('/shop');
  await expect(page.getByText('暂无管理权限', { exact: true })).toBeVisible();
  await request.get('/api/__test/expire');
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: '登录管理平台' })).toBeVisible();
});

test('non-admin account is rejected without entering workspace', async ({ page }) => {
  await signIn(page, 'member');
  await expect(page.getByText('该账号没有管理权限，请使用管理员账号登录')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '用户管理' })).toHaveCount(0);
});

test('mobile navigation and deep links work without document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/users?status=PENDING');
  await page.getByLabel('管理员账号').fill('core');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用户管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开导航' }).click();
  await page.getByRole('menuitem', { name: '战队赛事' }).click();
  await expect(page.getByRole('heading', { name: '战队赛事', exact: true })).toBeVisible();
  await expect(page.getByRole('cell').filter({ hasText: '验收测试战队赛' })).toBeVisible();
  await expect(page.getByRole('dialog', { includeHidden: true })).toBeHidden();
  await page.screenshot({
    path: 'output/seasons-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});

test('failed writes keep records unchanged and report the server error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page);
  await page.goto('/users?status=PENDING');
  await expect(page.getByText('测试选手#0001')).toBeVisible();
  await page.route('**/api/admin/users/status', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: '验收测试：无权修改此账号' }),
    }),
  );
  await page.getByRole('button', { name: '通过', exact: true }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByText('验收测试：无权修改此账号')).toBeVisible();
  await expect(page.getByText('测试选手#0001')).toBeVisible();
  expect(errors).toEqual([]);
});
