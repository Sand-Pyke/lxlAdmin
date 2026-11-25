// Run as root on the management host: in-memory internal session, read checks only.
// Verifies authenticated routing without storing or resetting administrator passwords.
import { loadEnvFile } from 'node:process';
import { createHmac } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

loadEnvFile(process.argv[2] || '/etc/lxl-admin/backend.env');
const base = process.argv[3] || 'https://8.133.23.125';
if (!new Set(['https://8.133.23.125', 'https://lxladmin.cn']).has(base)) {
  throw new Error('Read verification is restricted to the configured management origins');
}
const db = new PrismaClient();
try {
  const actor = await db.user.findFirst({
    where: { isAdmin: true, isCoreAdmin: true, status: 'APPROVED' },
    select: { id: true },
  });
  if (!actor) throw new Error('No approved core administrator available for read verification');
  const key = createHmac('sha256', process.env.ADMIN_SESSION_SECRET)
    .update('lxl-admin:session')
    .digest();
  const payload = `${actor.id}.${Date.now() + 60000}`;
  const token = `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
  async function check(route, { authenticated = true, status = 200, headers = {} } = {}) {
    const response = await fetch(base + route, {
      headers: {
        ...(authenticated ? { cookie: `__Host-lxl_admin_session=${token}` } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(25000),
      redirect: 'manual',
    });
    if (response.status !== status) throw new Error(`${route}: unexpected HTTP ${response.status}`);
    await response.arrayBuffer();
    console.log(`${route}: HTTP ${status}`);
  }
  await check('/', { authenticated: false });
  await check('/api/health', { authenticated: false });
  await check('/api/admin/users', { authenticated: false, status: 401 });
  for (const route of [
    '/api/current_user',
    '/api/admin/permissions',
    '/api/admin/users?page=0&pageSize=1',
    '/api/match/list?pageSize=1',
    '/api/admin/season/list',
    '/api/admin/shop',
    '/api/sponsors',
    '/api/admin/draft/music',
  ]) {
    await check(route);
  }
  await check('/assets/rank/Diamond.png', { authenticated: false });
  const music = (await readdir(path.join(process.env.ASSET_DIR, 'music'))).find((file) =>
    file.endsWith('.mp3'),
  );
  if (!music) throw new Error('No music file available');
  await check('/assets/music/' + encodeURIComponent(music), {
    authenticated: false,
    status: 206,
    headers: { range: 'bytes=0-15' },
  });
  const legacy = (await readdir(path.join(process.env.UPLOAD_DIR, 'avatars'))).find((file) =>
    /\.png$|\.jpg$/.test(file),
  );
  if (legacy)
    await check('/assets/avatars/' + encodeURIComponent(legacy), { authenticated: false });
  console.log(
    'Public HTTPS and internal-session read verification passed; no business writes or password changes',
  );
} finally {
  await db.$disconnect();
}
