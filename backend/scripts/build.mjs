import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Compiling dynamic API routes never needs a live database or production credentials.
const env = {
  ...process.env,
  DATABASE_URL: 'postgresql://build:build@127.0.0.1:1/build_only',
  ADMIN_SESSION_SECRET: randomBytes(48).toString('hex'),
  NEXT_TELEMETRY_DISABLED: '1',
};
for (const args of [
  ['node_modules/prisma/build/index.js', 'generate'],
  ['node_modules/next/dist/bin/next', 'build'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
