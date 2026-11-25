import { expect, test, type Page } from '@playwright/test';

async function enter(page: Page, path: string) {
  await page.goto(path);
  await page.getByLabel('管理员账号').fill('core');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test('community moderation deletes replies from the independent management page', async ({
  page,
}) => {
  let reply = true;
  await page.route('**/api/admin/community/12', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    reply = false;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/admin/community?*', (route) =>
    route.fulfill({
      json: {
        posts: [
          {
            id: 11,
            content: '验收帖子',
            created_at: '2026-11-25T00:00:00Z',
            comments: reply
              ? [{ id: 12, content: '待移除回复', created_at: '2026-11-25T00:00:00Z' }]
              : [],
          },
        ],
        total: 1,
      },
    }),
  );
  await enter(page, '/community');
  await expect(page.getByText('验收帖子')).toBeVisible();
  await page.locator('button.ant-table-row-expand-icon').click();
  await page.getByRole('button', { name: '删除回复' }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByText('待移除回复')).toHaveCount(0);
  expect(reply).toBe(false);
});

test('video publishing sends chunks then completes the upload in the new workspace', async ({
  page,
}) => {
  let published = false;
  await page.route('**/api/admin/videos?page=*', (route) =>
    route.fulfill({
      json: {
        videos: published
          ? [
              {
                id: 1,
                title: '验收视频',
                size: 12,
                created_at: '2026-11-25T00:00:00Z',
                url: '/assets/videos/v123_abcd.mp4',
              },
            ]
          : [],
        hasMore: false,
      },
    }),
  );
  await page.route('**/api/admin/videos/upload/init', (route) =>
    route.fulfill({ json: { uploadId: 'fixture', chunkSize: 1024, chunkCount: 1 } }),
  );
  await page.route('**/api/admin/videos/upload/status?*', (route) =>
    route.fulfill({ json: { uploaded: [] } }),
  );
  await page.route('**/api/admin/videos/upload/chunk?*', (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataBuffer()?.length).toBe(12);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/admin/videos/upload/complete', (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      uploadId: 'fixture',
      title: '验收视频',
    });
    published = true;
    return route.fulfill({ json: { job: { phase: 'done' } } });
  });
  await enter(page, '/videos');
  await page.getByRole('button', { name: '上传视频' }).click();
  await page.getByLabel('标题', { exact: true }).fill('验收视频');
  await page
    .locator('input[type=file]')
    .setInputFiles({
      name: 'fixture.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('fixture-data'),
    });
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放视频：验收视频' })).toBeVisible();
});
