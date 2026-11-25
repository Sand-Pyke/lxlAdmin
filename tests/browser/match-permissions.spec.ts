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
  test(`regular match deletion is visible only to core admins: ${role}`, async ({
    page,
    request,
  }) => {
    await request.get('/api/__test/reset');
    await page.route('**/api/admin/teams/1', (route) => route.fulfill({ json: board }));
    await page.goto('/matches/1');
    await page.getByLabel('管理员账号').fill(role);
    await page.getByLabel('密码', { exact: true }).fill('fixture-only');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.page-title')).toContainText(board.match.name);
    const deleteButton = page.getByRole('button', { name: /删除赛事$/ });
    if (role === 'core') {
      await expect(deleteButton).toBeVisible();
      await deleteButton.click();
      await expect(
        page.getByText(`删除赛事「${board.match.name}」？`, { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '取消', exact: true }).click();
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
