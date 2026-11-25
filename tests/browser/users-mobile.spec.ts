import { expect, test } from '@playwright/test';

test('mobile user rows keep the identity beside a compact action column', async ({
  page,
  request,
}) => {
  await request.get('/api/__test/reset');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/admin/users?*', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const moreUsers = Array.from({ length: 8 }, (_, index) => ({
      ...data.users[1],
      id: 100 + index,
      username: `mobile-fixture-${index + 1}`,
    }));
    await route.fulfill({
      response,
      json: { ...data, users: [...data.users, ...moreUsers], total: 10 },
    });
  });
  await page.goto('/users');
  await page.getByLabel('管理员账号').fill('core');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();

  const table = page.locator('.users-table');
  const user = table.getByRole('row').filter({ hasText: 'approved-player' });
  const identity = user.locator('.users-identity');
  const avatar = identity.locator('.ant-avatar');
  const rank = user.getByRole('button', { name: '重置段位', exact: true });
  const more = user.getByRole('button', { name: '更多', exact: true });
  const actions = user.getByRole('cell').filter({
    has: page.getByRole('button', { name: '重置段位', exact: true }),
  });
  const search = page.getByLabel('搜索用户');
  const filters = page.locator('.users-filters');
  const body = table.locator('.ant-table-body');
  await expect
    .poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  for (const width of [523, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(table).toHaveClass(/users-table-compact/);
    await expect(avatar).toBeInViewport();
    await expect(identity).toHaveText(/approved-player.*UID 8/);
    await expect(rank).toBeInViewport();
    await expect(more).toBeInViewport();
    const identityBox = await identity.boundingBox();
    const actionsBox = await actions.boundingBox();
    const rankBox = await rank.boundingBox();
    const moreBox = await more.boundingBox();
    const searchBox = await search.boundingBox();
    const filtersBox = await filters.boundingBox();
    expect(identityBox!.x + identityBox!.width).toBeLessThanOrEqual(actionsBox!.x);
    expect(actionsBox!.width).toBeLessThanOrEqual(110);
    expect(moreBox!.y).toBeGreaterThanOrEqual(rankBox!.y + rankBox!.height);
    expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(filtersBox!.x + filtersBox!.width);
  }

  const pending = table.getByRole('row').filter({ hasText: 'test-player' });
  await expect(pending.getByRole('button', { name: '通过', exact: true })).toBeInViewport();
  await expect(pending.getByRole('button', { name: '拒绝', exact: true })).toBeInViewport();
  await expect(pending.getByRole('button', { name: /重置段位|更多/ })).toHaveCount(0);

  await more.click();
  await expect(page.getByRole('menuitem', { name: '修改游戏 ID' })).toBeVisible();
  await page.keyboard.press('Escape');
  await rank.click();
  await expect(page.getByRole('dialog', { name: '重置段位' })).toBeVisible();
  await page.keyboard.press('Escape');

  await body.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(rank).toBeInViewport();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(table).not.toHaveClass(/users-table-compact/);
  await expect(rank).toBeInViewport();
});
