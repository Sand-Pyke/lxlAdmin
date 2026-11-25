import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { createProxyOptions } from './config/proxy.mjs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.BACKEND_ORIGIN || 'http://127.0.0.1:3001';
  if (Boolean(env.DEV_HTTPS_KEY) !== Boolean(env.DEV_HTTPS_CERT)) {
    throw new Error('DEV_HTTPS_KEY 和 DEV_HTTPS_CERT 必须同时配置');
  }
  return {
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      https: env.DEV_HTTPS_KEY
        ? {
            key: readFileSync(env.DEV_HTTPS_KEY),
            cert: readFileSync(env.DEV_HTTPS_CERT),
          }
        : undefined,
      proxy: {
        '/api/': createProxyOptions(target),
        '/assets/': createProxyOptions(target),
      },
    },
    build: {
      assetsDir: 'static',
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (
              /\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id)
            )
              return 'react-router';
            if (id.includes('/node_modules/@tanstack/')) return 'query';
          },
        },
      },
    },
  };
});
