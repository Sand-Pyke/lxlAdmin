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
