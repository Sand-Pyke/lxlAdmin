import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, username = 'core') {
  await page.goto('/markets');
  await page.getByLabel('管理员账号').fill(username);
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
const row = (page: Page, id: number) => page.getByRole('row').filter({ hasText: `#${id} ·` });
async function select(page: Page, name: string, option: string) {
  await page.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
test.beforeEach(async ({ request }) => {
  await request.get('/api/__test/reset');
});

test('regular game and season market opening preserve fixture and source IDs', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await expect(page.getByRole('heading', { name: '竞猜管理', exact: true })).toBeVisible();
  await select(page, '竞猜比赛', '竞猜验收常规赛');
  await expect(page.getByRole('button', { name: '开盘 / 更新赔率', exact: true })).toBeDisabled();
  await select(page, '竞猜对阵', '朱雀 vs 玄武 · 第 1 轮');
  await select(page, '竞猜盘口范围', '第 2 局');
  await page.getByRole('button', { name: '开盘 / 更新赔率', exact: true }).click();
  await expect(page.getByRole('dialog').filter({ hasText: '确认开盘 / 更新赔率？' })).toBeVisible();
  let calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.filter((call: { path: string }) => call.path === '/api/admin/markets/open'),
  ).toHaveLength(0);
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(row(page, 45)).toContainText('第 2 局');
  calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.find((call: { path: string }) => call.path === '/api/admin/markets/open').body,
  ).toEqual({ matchId: 1, teamOneId: 103, teamTwoId: 104, roundNo: 2 });

  await select(page, '竞猜赛事类型', '战队赛');
  await expect(page.getByRole('combobox', { name: '竞猜盘口范围', exact: true })).toBeDisabled();
  await select(page, '竞猜比赛', '竞猜验收战队赛');
  await page.getByRole('button', { name: '开盘 / 更新赔率', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(row(page, 46)).toContainText('战队赛 · 大场');
  calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.filter((call: { path: string }) => call.path === '/api/admin/markets/open').at(-1).body,
  ).toEqual({ seasonMatchId: 1 });
  expect(errors).toEqual([]);
});

test('bets, close, reopen, settlement and refund match old management workflows', async ({
  page,
  request,
}) => {
  await login(page);
  await expect(row(page, 41)).toBeVisible();
  await expect(row(page, 43).getByRole('button', { name: '作废退款' })).toHaveCount(0);
  await expect(row(page, 44).getByRole('button', { name: '重新开盘' })).toHaveCount(0);
  await row(page, 41).getByRole('button', { name: '下注明细' }).click();
  const drawer = page.getByRole('dialog').filter({ hasText: '下注明细 ·' });
  await expect(drawer.getByText('测试下注选手')).toBeVisible();
  await expect(drawer.getByRole('columnheader', { name: '预计返还', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await row(page, 41).getByRole('button', { name: '封盘', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(row(page, 41)).toContainText('已封盘');
  await row(page, 41).getByRole('button', { name: '重新开盘' }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(row(page, 41)).toContainText('开盘中');
  await row(page, 41).getByRole('button', { name: '青龙 胜', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('确认结算为「青龙 胜」？')).toBeVisible();
  await page.getByRole('button', { name: '确认结算', exact: true }).click();
  await expect(row(page, 41)).toContainText('已结算');
  await expect(row(page, 41).getByRole('button', { name: '青龙 胜' })).toHaveCount(0);
  const calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.find((call: { path: string }) => call.path === '/api/admin/markets/41/settle').body,
  ).toEqual({ winnerKey: 'TEAM_ONE_WIN' });
  await row(page, 42).getByRole('button', { name: '作废退款' }).click();
  await page.getByRole('button', { name: '确认作废退款', exact: true }).click();
  await expect(row(page, 42)).toContainText('已作废');
  await expect(row(page, 42).getByRole('button', { name: '重新开盘' })).toHaveCount(0);
  await expect(page.locator('.ant-message-notice')).toHaveCount(0);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelectorAll('.ant-table-content').forEach((element) => {
      element.scrollLeft = 0;
    });
  });
  await page.screenshot({
    path: 'output/markets-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('date filters use one-based server pagination and failed settlements keep the dialog', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const allDates = page.waitForRequest(
    (request) =>
      request.url().includes('/api/admin/markets?') && request.url().includes('range=all'),
  );
  await page.getByRole('button', { name: '全部日期', exact: true }).click();
  expect(new URL((await allDates).url()).searchParams.get('page')).toBe('1');
  await page.getByLabel('盘口开始日期', { exact: true }).fill('2020-01-01');
  await page.getByLabel('盘口结束日期', { exact: true }).fill('2020-01-02');
  const filtered = page.waitForRequest(
    (request) =>
      request.url().includes('startDate=2020-01-01') &&
      request.url().includes('endDate=2020-01-02'),
  );
  await page.getByRole('button', { name: '筛选日期', exact: true }).click();
  await filtered;
  await expect(page.getByText('暂无符合条件的数据')).toBeVisible();
  await page.getByRole('button', { name: '近两天', exact: true }).click();
  await expect(row(page, 41)).toBeVisible();
  await page.route('**/api/admin/markets/41/settle', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: '验收测试：结算冲突，请刷新' }),
    }),
  );
  await row(page, 41).getByRole('button', { name: '青龙 胜', exact: true }).click();
  await page.getByRole('button', { name: '确认结算', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/验收测试：结算冲突/)).toBeVisible();
  await expect(row(page, 41)).toContainText('开盘中');
  expect(errors).toEqual([]);
});

test('lower admins cannot enter the core-only betting workspace', async ({ page }) => {
  await login(page, 'reviewer');
  await expect(page.getByText('暂无管理权限', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '竞猜管理' })).toHaveCount(0);
});

test('mobile betting page remains usable without document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(row(page, 41)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: 'output/markets-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});
