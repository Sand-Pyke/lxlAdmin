/** Preserve the browser origin for the existing backend's CSRF check. Never rewrite Origin. */
export function createProxyOptions(target) {
  const url = new URL(target);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('BACKEND_ORIGIN 必须是无路径、无凭据的 HTTP(S) 地址');
  }
  return {
    target: url.origin,
    changeOrigin: true,
    secure: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq, req) => {
        // Overwrite untrusted forwarded headers rather than passing them through.
        proxyReq.setHeader('x-forwarded-host', req.headers.host || '127.0.0.1:5174');
        proxyReq.setHeader('x-forwarded-proto', req.socket.encrypted ? 'https' : 'http');
        proxyReq.setHeader('x-forwarded-for', req.socket.remoteAddress || '127.0.0.1');
      });
    },
  };
}
