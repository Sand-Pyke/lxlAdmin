import { fileURLToPath } from 'node:url';
/** API service only; the Vite application remains the management UI. */
export default {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  serverExternalPackages: ['ali-oss'],
  experimental: { cpus: 1, middlewareClientMaxBodySize: '250mb' },
  poweredByHeader: false,
};
