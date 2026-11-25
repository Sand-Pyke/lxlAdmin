import { spawn } from 'node:child_process';
import env from '@next/env';

const mode = process.argv[2];
if (!['dev', 'start'].includes(mode)) throw new Error('Expected dev or start');
env.loadEnvConfig(process.cwd(), mode === 'dev');
if (!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL || '')) {
  throw new Error('Set DATABASE_URL in backend/.env before starting the management backend');
}
if (Buffer.byteLength(process.env.ADMIN_SESSION_SECRET || '') < 32) {
  throw new Error('Set an independent ADMIN_SESSION_SECRET of at least 32 bytes in backend/.env');
}
const port = process.env.ADMIN_API_PORT || '3001';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error('Invalid ADMIN_API_PORT');
const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', mode, '--hostname', '127.0.0.1', '--port', port],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
