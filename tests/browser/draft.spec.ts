import { test, expect, type Page } from '@playwright/test';
async function login(page: Page, path = '/matches') {
  await page.goto(path);
  await page.getByLabel('管理员账号').fill('core');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}
async function enter(page: Page) {
  await login(page);
  await page.locator('a[href="/matches/1"]').click();
  await page.getByRole('button', { name: '大屏选人', exact: true }).click();
  await page.getByRole('button', { name: 'DK', exact: true }).click();
  await page.getByRole('button', { name: 'T1', exact: true }).click();
  await page.getByRole('button', { name: /前进/ }).click();
  await expect(page.locator('.big-draft-player-card').first()).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  await request.get('/api/__test/reset');
});

test('draft opens while the music catalogue is still loading', async ({ page }) => {
  let finishMusic!: () => void;
  const musicGate = new Promise<void>((resolve) => {
    finishMusic = resolve;
  });
  await page.route('**/api/admin/draft/music', async (route) => {
    await musicGate;
    await route.continue();
  });
  try {
    await login(page, '/draft/1');
    await expect(page.getByRole('button', { name: 'DK', exact: true })).toBeVisible();
  } finally {
    finishMusic();
  }
  await expect(
    page.getByRole('button', { name: '播放背景音乐，展开歌曲列表', exact: true }),
  ).toBeVisible();
});

test('team selection submits one batch and enters while the follow-up read is pending', async ({
  page,
  request,
}) => {
  await login(page, '/draft/1');
  await page.getByRole('button', { name: 'DK', exact: true }).click();
  await page.getByRole('button', { name: 'T1', exact: true }).click();
  let finishRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  await page.route('**/api/admin/pick/1?live=1', async (route) => {
    await readGate;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: /前进/ }).click();
    await expect(page.locator('[data-team-group-id="201"]')).toBeVisible();
    await expect(page.locator('[data-team-group-id="202"]')).toBeVisible();
    await expect(page.locator('.big-draft-player-card').first()).toBeVisible();
    const calls = await (await request.get('/api/__test/calls')).json();
    const writes = calls.filter(
      (call: { path: string }) =>
        call.path === '/api/admin/pick/1/teams' || call.path === '/api/admin/team/create',
    );
    expect(writes).toEqual([
      expect.objectContaining({ path: '/api/admin/pick/1/teams', body: { names: ['DK', 'T1'] } }),
    ]);
  } finally {
    finishRead();
  }
});

test('1.0 manual picks, unassignment, rank filtering, budget override and refresh recovery', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await request.get('/api/__test/draft-budget');
  await enter(page);
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /保存并查看对阵/ })).toBeDisabled();
  await page.getByRole('button', { name: '黄金', exact: true }).click();
  await expect(page.getByText('该分类暂无可选选手')).toBeVisible();
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.locator('[data-sign-id="101"]').click();
  await expect(page.getByRole('dialog').getByText('队伍预算不足')).toBeVisible();
  await page.getByRole('button', { name: '确认并继续选人', exact: true }).click();
  const team = page.locator('[data-team-group-id="201"]');
  await expect(team).toContainText('选人测试1#1234');
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(team).toContainText('选人测试1#1234');
  await team.locator('.big-draft-roster-slot.filled').click();
  await page.getByRole('button', { name: '取消选择并退回待选池', exact: true }).click();
  await expect(team).not.toContainText('选人测试1#1234');
  const calls = await (await request.get('/api/__test/calls')).json();
  expect(
    calls.find(
      (call: { path: string; body: { teamId: number } }) =>
        call.path === '/api/admin/team/assign' && call.body.teamId === 201,
    ).body,
  ).toMatchObject({ signId: 101, teamPosition: 'TOP', overrideBudget: 6 });
  expect(errors).toEqual([]);
});

test('automatic assignment, drag order, lineup preview and finish all stay inside the new admin', async ({
  page,
  request,
}) => {
  await enter(page);
  await page.getByRole('button', { name: /智能分配/ }).click();
  await expect(page.getByRole('button', { name: /保存并查看对阵/ })).toBeEnabled();
  await page.getByRole('button', { name: '调整对战顺序', exact: true }).click();
  const first = page.locator('[data-team-group-id="201"]');
  const second = page.locator('[data-team-group-id="202"]');
  await first.dragTo(second);
  await expect
    .poll(async () => {
      const calls = await (await request.get('/api/__test/calls')).json();
      return calls.filter((call: { path: string }) => call.path === '/api/admin/team/reorder')
        .length;
    })
    .toBe(1);
  await expect(page.locator('.ant-message-notice')).toHaveCount(0);
  await page.screenshot({
    path: 'output/draft-workspace.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: /保存并查看对阵/ }).click();
  await expect(page).toHaveURL(/\/matches\/1\/lineup$/);
  await expect(page.getByRole('heading', { name: /对阵预览/ })).toBeVisible();
  await page.getByRole('button', { name: '结束选人并开赛', exact: true }).click();
  await page.getByRole('button', { name: '确认开赛', exact: true }).click();
  await expect(page.getByText('该赛事已开赛或结束，当前显示已保存的队伍名单。')).toBeVisible();
});

test('clear keeps teams, browser-back can keep editing, and discarding removes the draft', async ({
  page,
  request,
}) => {
  await enter(page);
  await page.getByRole('button', { name: /智能分配/ }).click();
  await expect(page.getByRole('button', { name: /保存并查看对阵/ })).toBeEnabled();
  await page.getByRole('button', { name: /清空选人/ }).click();
  await page.getByRole('button', { name: '清空选人（包括队长）', exact: true }).click();
  await expect(page.locator('.big-draft-roster-slot.filled')).toHaveCount(0);
  await expect(page.locator('.big-draft-roster-group')).toHaveCount(2);
  await page.goBack();
  await expect(page.getByRole('dialog').getByText('返回前保存选人草稿？')).toBeVisible();
  await page.getByRole('button', { name: '继续选人', exact: true }).click();
  await expect(page).toHaveURL(/\/draft\/1$/);
  await page.getByRole('button', { name: /退出/, exact: false }).click();
  await page.getByRole('button', { name: '不保存并清空', exact: true }).click();
  await expect(page).toHaveURL(/\/matches$/);
  const result = await (await page.request.get('/api/admin/pick/1')).json();
  expect(result.board.teams).toHaveLength(0);
  expect(result.signs).toHaveLength(10);
});

test('captain setup gates picking in both draft modes', async ({ page, request }) => {
  await request.get('/api/__test/draft-captains');
  await login(page, '/draft/1');
  await expect(page.getByText('等待 2 位队长完成队伍设置，暂不能开始选人。')).toBeVisible();
  await expect(page.getByRole('button', { name: /智能分配/ })).toBeDisabled();
  await page.goto('/admin/auction/1');
  await expect(page.getByText(/大屏选人 2.0 · 每队手选/)).toBeVisible();
  await expect(page.getByRole('button', { name: /智能分配$/ })).toBeDisabled();
});

test('music playback and volume work through the media proxy', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: '播放背景音乐，展开歌曲列表', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '暂停背景音乐，展开歌曲列表', exact: true }),
  ).toBeVisible();
  const volume = page.getByLabel('背景音乐音量');
  await volume.focus();
  await volume.press('Home');
  for (let i = 0; i < 20; i++) await volume.press('ArrowRight');
  await expect(page.getByText('20%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停背景音乐，展开歌曲列表', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '播放背景音乐，展开歌曲列表', exact: true }),
  ).toBeVisible();
});

test('draft remains usable on smaller screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await expect(page.locator('.big-draft')).toBeVisible();
  await expect(page.getByRole('button', { name: /保存并查看对阵/ })).toBeInViewport();
  expect(
    await page.locator('.big-draft-pool').evaluate((el) => el.getBoundingClientRect().right),
  ).toBeLessThanOrEqual(390);
  await expect(page.locator('.ant-message-notice')).toHaveCount(0);
  await page.screenshot({
    path: 'output/draft-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('server permissions protect the direct draft route and individual reset controls', async ({
  page,
}) => {
  let denied = 'draft.reset';
  await page.route('**/api/admin/permissions', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.permissions = data.permissions.filter((permission: string) => permission !== denied);
    await route.fulfill({ response, json: data });
  });
  await enter(page);
  await expect(page.getByRole('button', { name: /清空选人/ })).toHaveCount(0);
  denied = 'draft.control';
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByText('没有大屏选人权限', { exact: true })).toBeVisible();
  await expect(page.locator('.big-draft')).toHaveCount(0);
});

test('a missing music endpoint uses legacy tracks and music failures do not prevent drafting', async ({
  page,
}) => {
  let status = 404;
  await page.route('**/api/admin/draft/music', (route) =>
    route.fulfill({ status, json: { error: 'fixture music unavailable' } }),
  );
  await login(page, '/draft/1');
  await page.getByRole('button', { name: '播放背景音乐，展开歌曲列表', exact: true }).click();
  await expect(
    page.getByRole('list', { name: '歌曲列表' }).getByText('Way Too Long'),
  ).toBeVisible();
  status = 500;
  await page.reload();
  await expect(page.getByText('音乐列表加载失败，选人仍可继续')).toBeVisible();
  await expect(page.getByRole('button', { name: 'DK', exact: true })).toBeVisible();
  status = 404;
  await page.getByRole('button', { name: '重新加载音乐' }).click();
  await expect(page.getByText('音乐列表加载失败，选人仍可继续')).toHaveCount(0);
});

test('2.0 enables balanced completion after two manual rounds and preserves those picks', async ({
  page,
  request,
}) => {
  await request.get('/api/__test/draft-second-round');
  await login(page, '/matches/1');
  await page.getByRole('button', { name: '大屏选人 2.0', exact: true }).click();
  await expect(page).toHaveURL(/\/draft\/1\/v2$/);
  const auto = page.getByRole('button', { name: /智能分配$/ });
  await expect(auto).toBeDisabled();
  await page.getByRole('tab', { name: /MID/ }).click();
  await page.locator('[data-sign-id="103"]').click();
  await expect(page.locator('[data-team-group-id="201"]')).toContainText('选人测试3#1234');
  await expect(auto).toBeDisabled();
  await page.getByRole('tab', { name: /MID/ }).click();
  await page.locator('[data-sign-id="108"]').click();
  await expect(auto).toBeEnabled();
  const submitted = page.waitForRequest((req) => req.url().endsWith('/api/admin/team/auto_assign'));
  await auto.click();
  expect((await submitted).postDataJSON()).toMatchObject({
    balancedDraft: true,
    draftTeamIds: [201, 202],
  });
  const save = page.getByRole('button', { name: /保存并查看对阵$/ });
  await expect(save).toBeEnabled();
  await expect(page.locator('[data-team-group-id="201"]')).toContainText('选人测试3#1234');
  await expect(page.locator('[data-team-group-id="202"]')).toContainText('选人测试8#1234');
  await save.click();
  await expect(page).toHaveURL(/\/lineup\?mode=2$/);
});
