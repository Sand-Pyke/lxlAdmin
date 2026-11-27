import { test, expect, type Page } from '@playwright/test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  'base64',
);
async function login(page: Page, path = '/shop', username = 'core') {
  await page.goto(path);
  await page.getByLabel('管理员账号').fill(username);
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
async function select(page: Page, label: string, option: string) {
  await page.getByRole('dialog').getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function chooseRechargeUser(page: Page) {
  await page.getByLabel('搜索充值用户').fill('approved');
  const select = page.getByRole('combobox', { name: '充值用户', exact: true });
  await expect(select).toBeEnabled();
  await select.click();
  await page
    .getByRole('option', { name: 'approved-player · 测试队长#0002 · UID 8', exact: true })
    .click();
}
test.beforeEach(async ({ request }) => {
  await request.get('/api/__test/reset');
});

test('an outer-effect avatar frame previews and saves as a shared image', async ({
  page,
  request,
}) => {
  await login(page);
  await page.getByRole('button', { name: '新建商品', exact: true }).click();
  await select(page, '头像框样式', '离子王座 · 动态');
  const dialog = page.getByRole('dialog');
  const image = dialog.getByAltText('商品图片预览');
  await expect(image).toHaveAttribute('src', '/avatar-frame-presets/ion-throne.svg');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
  await dialog.getByLabel('价格（冠军币）', { exact: true }).fill('1999');
  await dialog.getByRole('button', { name: '保存商品', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '头像框·离子王座' })).toBeVisible();
  const calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.find((call: { path: string }) => call.path === '/api/admin/shop/upload-icon').body.file,
  ).toMatchObject({ name: 'ion-throne.svg', type: 'image/svg+xml' });
  expect(
    calls.find((call: { path: string }) => call.path === '/api/admin/shop/create').body,
  ).toMatchObject({
    category: 'AVATAR_FRAME',
    avatarFrameStyle: '',
    icon: '/assets/shop-icons/fixture-icon.png',
  });
});

test('a dynamic nameplate template previews and publishes through the shared shop upload', async ({
  page,
  request,
}) => {
  await login(page);
  await page.getByRole('button', { name: '新建商品', exact: true }).click();
  await select(page, '商品分类', '铭牌');
  await select(page, '铭牌样式', '黑曜龙息 · 动态');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('商品名称', { exact: true })).toHaveValue('铭牌·黑曜龙息');
  const image = dialog.getByAltText('商品图片预览');
  await expect(image).toHaveAttribute('src', '/nameplate-presets/black-dragon.svg');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1000);
  await dialog.getByLabel('价格（冠军币）', { exact: true }).fill('1999');
  await dialog.getByRole('button', { name: '保存商品', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '铭牌·黑曜龙息' })).toBeVisible();
  const calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls
      .filter((call: { path: string }) =>
        ['/api/admin/shop/upload-icon', '/api/admin/shop/create'].includes(call.path),
      )
      .map((call: { body: object }) => call.body),
  ).toEqual([
    expect.objectContaining({
      file: expect.objectContaining({ name: 'black-dragon.svg', type: 'image/svg+xml' }),
    }),
    expect.objectContaining({
      category: 'NAMEPLATE',
      effectValue: 'custom',
      icon: '/assets/shop-icons/fixture-icon.png',
    }),
  ]);
});

test('custom image upload, creation, editing and confirmed deletion work end to end', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await page.getByRole('button', { name: '新建商品', exact: true }).click();
  await select(page, '商品分类', '铭牌');
  await select(page, '铭牌样式', '自定义横幅');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('商品名称', { exact: true }).fill('验收自定义铭牌');
  await dialog.getByLabel('价格（冠军币）', { exact: true }).fill('80');
  await dialog
    .locator('input[type=file]')
    .setInputFiles({ name: 'nameplate.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByLabel('图片地址或图标', { exact: true })).toHaveValue(
    '/assets/shop-icons/fixture-icon.png',
  );
  await expect(dialog.getByAltText('商品图片预览')).toBeVisible();
  await dialog.getByRole('button', { name: '保存商品', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: '验收自定义铭牌' });
  await expect(row).toBeVisible();
  let calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.find((call: { path: string }) => call.path === '/api/admin/shop/upload-icon').body.file,
  ).toEqual({ name: 'nameplate.png', type: 'image/png', size: png.length });
  expect(
    calls.find((call: { path: string }) => call.path === '/api/admin/shop/create').body,
  ).toMatchObject({
    category: 'NAMEPLATE',
    icon: '/assets/shop-icons/fixture-icon.png',
    effectValue: 'custom',
    price: 80,
    durationDays: null,
  });
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(dialog.getByLabel('商品分类', { exact: true })).toBeDisabled();
  await dialog.getByLabel('价格（冠军币）', { exact: true }).fill('120');
  await dialog.getByLabel('有效期（天）', { exact: true }).fill('30');
  await dialog.getByLabel('库存', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: '保存商品', exact: true }).click();
  await expect(row).toContainText('120 冠军币');
  await expect(row).toContainText('30 天');
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog).toContainText('用户已购背包记录保留');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(row).toBeVisible();
  calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.filter(
      (call: { path: string; body: object }) =>
        call.path === '/api/admin/shop/4' && Object.keys(call.body).length === 0,
    ),
  ).toHaveLength(0);
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('editing a built-in card preserves effect fields and upload failures block saving', async ({
  page,
  request,
}) => {
  await login(page);
  const row = page.getByRole('row').filter({ hasText: '验收测试道具' });
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.route('**/api/admin/shop/upload-icon', (route) =>
    route.fulfill({
      status: 413,
      contentType: 'application/json',
      body: JSON.stringify({ error: '验收测试：图片过大' }),
    }),
  );
  await dialog
    .locator('input[type=file]')
    .setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png });
  await expect(dialog.getByText('验收测试：图片过大')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '保存商品', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '保留当前图片', exact: true }).click();
  await dialog.getByLabel('商品名称', { exact: true }).fill('道具资料修改');
  await dialog.getByRole('button', { name: '保存商品', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '道具资料修改' })).toBeVisible();
  const calls = await (await request.get('/api/__test/calls')).json();
  const body = calls.find((call: { path: string }) => call.path === '/api/admin/shop/3').body;
  for (const key of ['category', 'effectType', 'effectJson', 'groupCode', 'code'])
    expect(body).not.toHaveProperty(key);
});

test('failed deletion keeps the product and displays the server response', async ({ page }) => {
  await login(page);
  await page.route('**/api/admin/shop/3', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: '验收测试：商品删除冲突' }),
        })
      : route.continue(),
  );
  const row = page.getByRole('row').filter({ hasText: '验收测试道具' });
  await row.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('验收测试：商品删除冲突')).toBeVisible();
  await expect(row).toBeVisible();
});

test('recharge confirms identity, credits once and displays the resulting balance', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, '/recharge');
  await chooseRechargeUser(page);
  await page.getByLabel('充值金额（冠军币）', { exact: true }).fill('123');
  await page.getByLabel('充值备注', { exact: true }).fill(' 活动奖励 ');
  await page.getByRole('button', { name: '核对充值信息', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('approved-player');
  await expect(dialog).toContainText('123 冠军币');
  let calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.filter((call: { path: string }) => call.path === '/api/admin/points/recharge'),
  ).toHaveLength(0);
  await page.route('**/api/admin/points/recharge', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await dialog.getByRole('button', { name: '确认到账', exact: true }).dblclick();
  await expect(page.getByText('323 冠军币', { exact: true })).toBeVisible();
  calls = await (await request.get('/api/__test/calls')).json();
  const recharges = calls.filter(
    (call: { path: string }) => call.path === '/api/admin/points/recharge',
  );
  expect(recharges).toHaveLength(1);
  expect(recharges[0].body).toEqual({ userId: 8, amount: 123, note: '活动奖励' });
  expect(errors).toEqual([]);
  await page.screenshot({
    path: 'output/recharge-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('uncertain recharge delivery is not automatically retried', async ({ page }) => {
  await login(page, '/recharge');
  await chooseRechargeUser(page);
  await page.getByLabel('充值金额（冠军币）', { exact: true }).fill('100');
  await page.getByRole('button', { name: '核对充值信息', exact: true }).click();
  let attempts = 0;
  await page.route('**/api/admin/points/recharge', (route) => {
    attempts++;
    return route.abort('failed');
  });
  await page.getByRole('button', { name: '确认到账', exact: true }).click();
  await expect(page.getByText('本次充值结果尚未确认，已阻止重复提交')).toBeVisible();
  await expect(page.getByRole('button', { name: '核对充值信息', exact: true })).toBeDisabled();
  expect(attempts).toBe(1);
});

test('recharge authorization and mobile form layout match core-only product management', async ({
  page,
}) => {
  await login(page, '/recharge', 'reviewer');
  await expect(page.getByText('暂无管理权限', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '冠军币充值' })).toHaveCount(0);
});

test('mobile product editor fits the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: '新建商品', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('商品名称', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: 'output/shop-editor-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});
