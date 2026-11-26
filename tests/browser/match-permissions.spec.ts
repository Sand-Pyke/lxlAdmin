import { expect, test } from '@playwright/test';

const board = {
  match: {
    id: 1,
    name: '权限验收赛事',
    status: 'CREATED',
    use_fee: false,
    bo: 'BO3',
    total_rounds: 1,
    champion_team_id: null,
    captain_position: '',
    round: '常规赛',
    date: null,
    live_url: null,
    prize_pool_json: '{}',
    prize_distributed: false,
    team_count: 0,
  },
  teams: [],
  signs: [],
  current_round: 1,
  round_ended: false,
  has_score: false,
  round_pairs: [],
  budget: 0,
  fmvp: null,
};

for (const role of ['core', 'reviewer', 'admin']) {
  test(`regular draft match deletion is visible to core and secondary admins: ${role}`, async ({
    page,
    request,
  }) => {
    await request.get('/api/__test/reset');
    let status = 'CREATED';
    await page.route('**/api/admin/teams/1', (route) =>
      route.fulfill({ json: { ...board, match: { ...board.match, status } } }),
    );
    await page.goto('/matches/1');
    await page.getByLabel('管理员账号').fill(role);
    await page.getByLabel('密码', { exact: true }).fill('fixture-only');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.page-title')).toContainText(board.match.name);
    const deleteButton = page.getByRole('button', { name: /删除赛事$/ });
    if (role !== 'admin') {
      await expect(deleteButton).toBeVisible();
      await deleteButton.click();
      await expect(
        page.getByText(`删除赛事「${board.match.name}」？`, { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      status = 'LIVE';
      await page.reload();
      await expect(deleteButton).toBeDisabled();
    } else {
      await expect(deleteButton).toHaveCount(0);
    }
    const calls = await (await request.get('/api/__test/calls')).json();
    expect(calls.some((call: { path: string }) => call.path.includes('/match/delete/'))).toBe(
      false,
    );
  });
}

test('score entry shows loading and prevents another submission until the save finishes', async ({
  page,
  request,
}) => {
  await request.get('/api/__test/reset');
  await page.route('**/api/admin/teams/1', (route) =>
    route.fulfill({
      json: {
        ...board,
        match: { ...board.match, status: 'LIVE', team_count: 2 },
        teams: ['Fixture A', 'Fixture B'].map((name, index) => ({
          id: index + 1,
          name,
          sort_order: index + 1,
          draft_order: index + 1,
          player_count: 5,
          used_fee: 0,
        })),
        round_pairs: [{ team_one: 1, team_two: 2, score_one: 0, score_two: 0, has_score: false }],
      },
    }),
  );
  let releaseSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let submissions = 0;
  await page.route('**/api/admin/match/score', async (route) => {
    submissions++;
    await pendingSave;
    await route.fulfill({ json: { msg: '战果已保存' } });
  });
  await page.route('**/api/admin/match/round/end/1', (route) =>
    route.fulfill({ json: { msg: '决赛结束' } }),
  );
  await page.goto('/matches/1');
  await page.getByLabel('管理员账号').fill('core');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '录入本轮战果' }).click();
  const dialog = page.getByRole('dialog', { name: /录入.*战果/ });
  const field = dialog.getByRole('spinbutton').first();
  await field.fill('2');
  const save = dialog.getByRole('button', { name: /保存$/ });
  await save.click();
  try {
    await expect.poll(() => submissions).toBe(1);
    await expect(save).toHaveClass(/ant-btn-loading/);
    await expect(field).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '取消' })).toBeDisabled();
    await save.evaluate((button) => (button as HTMLButtonElement).click());
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally {
    releaseSave();
  }
  await expect(dialog).not.toBeVisible();
  expect(submissions).toBe(1);
});

test('custom tournament creation submits the selected roster size, round formats and rank', async ({
  page,
  request,
}) => {
  await request.get('/api/__test/reset');
  await page.route('**/api/match/list?*', (route) =>
    route.fulfill({ json: { match_list: [], total: 0 } }),
  );
  await page.route('**/api/admin/match/create', (route) =>
    route.fulfill({ json: { id: 1, msg: '赛事已创建' } }),
  );
  await page.goto('/matches?create=1');
  await page.getByLabel('管理员账号').fill('core');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('赛事名称').fill('周末自定义赛');
  await dialog.getByLabel('赛制', { exact: true }).click();
  await expect(page.getByRole('option', { name: '八队模式', exact: true })).toHaveCount(1);
  await expect(page.getByText('八队模式2.0', { exact: true })).toHaveCount(0);
  await expect(page.getByText('BO1', { exact: true })).toHaveCount(0);
  await page.getByText('自定义赛事', { exact: true }).click();
  await dialog.getByLabel('正式参赛人数').click();
  await page.getByText('30 人（6 队）', { exact: true }).click();
  await expect(dialog.getByLabel('第 3 轮赛制')).toBeVisible();
  await dialog.getByLabel('正式参赛人数').click();
  await page.getByText('20 人（4 队）', { exact: true }).click();
  await expect(dialog.getByLabel('第 3 轮赛制')).toHaveCount(0);
  for (const round of [1, 2]) {
    const selector = dialog.getByLabel('第 ' + round + ' 轮赛制');
    await selector.click();
    const listId = await selector.getAttribute('aria-controls');
    await page
      .locator('[id="' + listId + '"]')
      .getByRole('option', { name: 'BO5', exact: true })
      .click();
  }
  await dialog.getByLabel('最低报名段位').click();
  await page.getByText('钻石及以上', { exact: true }).click();
  const itemCards = dialog.getByRole('switch', { name: '允许使用道具卡' });
  await expect(itemCards).toHaveAttribute('aria-checked', 'true');
  await itemCards.click();
  const submitted = page.waitForRequest((call) => call.url().endsWith('/api/admin/match/create'));
  await dialog.getByRole('button', { name: '创建赛事' }).click();
  expect((await submitted).postDataJSON()).toMatchObject({
    bo: '自定义赛事',
    custom_team_count: 4,
    round_formats: ['BO5', 'BO5'],
    min_signup_rank: '钻石',
    allow_item_cards: false,
    use_fee: true,
    captain_position: '',
  });
});

test('a pending BO3 tournament can change format from the main edit dialog', async ({
  page,
  request,
}) => {
  await request.get('/api/__test/reset');
  await page.route('**/api/admin/teams/1', (route) => route.fulfill({ json: board }));
  await page.route('**/api/admin/match/update/1', (route) =>
    route.fulfill({ json: { msg: '比赛信息已更新' } }),
  );
  await page.goto('/matches/1');
  await page.getByLabel('管理员账号').fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '编辑赛事', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /编辑赛事/ });
  await expect(dialog.getByText('BO3', { exact: true })).toBeVisible();
  await expect(dialog.getByText('不指定（沿用首位入队者为队长）', { exact: true })).toBeVisible();
  await dialog.getByLabel('赛事名称').fill('自定义赛');
  await dialog.getByLabel('赛制', { exact: true }).click();
  await page.getByRole('option', { name: '自定义赛事', exact: true }).click();
  await expect(dialog.getByLabel('第 2 轮赛制')).toBeVisible();
  const saved = page.waitForRequest((req) => req.url().endsWith('/api/admin/match/update/1'));
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    name: '自定义赛',
    bo: '自定义赛事',
    custom_team_count: 4,
    round_formats: ['BO3', 'BO3'],
    captain_position: '',
  });
  await expect(dialog).toBeHidden();
});
