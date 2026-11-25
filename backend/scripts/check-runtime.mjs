import env from '@next/env';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { Prisma, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';

if (process.argv[2]) loadEnvFile(path.resolve(process.argv[2]));
env.loadEnvConfig(process.cwd());
if (!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL || ''))
  throw new Error('DATABASE_URL is required');
if (Buffer.byteLength(process.env.ADMIN_SESSION_SECRET || '') < 32)
  throw new Error('Independent ADMIN_SESSION_SECRET is required');
if (!process.env.ASSET_DIR)
  throw new Error('ASSET_DIR must point at the shared/synchronized catalogue');
await access(path.join(process.env.ASSET_DIR, 'rank', 'Diamond.png'));
await access(path.join(process.env.ASSET_DIR, 'music'));
const ossKeys = ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'];
const configured = ossKeys.filter((key) => process.env[key]);
if (configured.length && configured.length !== ossKeys.length)
  throw new Error('OSS configuration is incomplete');
if (!configured.length && !process.env.UPLOAD_DIR)
  throw new Error('Shared upload storage or OSS is required');
if (process.env.UPLOAD_DIR) await access(process.env.UPLOAD_DIR);
execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], {
  stdio: 'ignore',
  timeout: 10000,
});
const db = new PrismaClient();
try {
  await db.$queryRaw`SELECT 1`;
  const columns = await db.$queryRaw`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
  `;
  const present = new Set(
    columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`),
  );
  const missing = [];
  for (const model of Prisma.dmmf.datamodel.models) {
    for (const field of model.fields.filter((field) => field.kind !== 'object')) {
      const column = `${model.dbName || model.name}.${field.dbName || field.name}`;
      if (!present.has(column)) missing.push(column);
    }
  }
  if (missing.length)
    throw new Error('Production schema is missing required columns: ' + missing.join(', '));
  // Read-only compatibility checks, no migrations, seeds or data modifications.
  await db.user.findFirst({
    select: { id: true, isAdmin: true, isCoreAdmin: true, pendingRank: true },
  });
  await db.playerProfile.findFirst({ select: { id: true, rank: true } });
  await db.matchSignup.findFirst({ select: { id: true, rankAtSignup: true } });
  console.log('Read-only database/schema and media configuration checks passed');
} finally {
  await db.$disconnect();
}
