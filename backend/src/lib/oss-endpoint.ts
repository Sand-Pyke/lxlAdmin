/**
 * OSS 访问地址推断（纯计算，不依赖 Node API）。
 *
 * `src/middleware.ts` 的 CSP 与 `src/server/uploads.ts` 的 OSS 客户端共用这份规则，
 * 避免「客户端往某个域名传、CSP 却没放行这个域名」这类只能在生产环境复现的错位。
 *
 * 默认地址是公网域名 `https://<bucket>.<region>.aliyuncs.com`；配置 `OSS_ENDPOINT`
 * 时以它为准（阿里云内网 endpoint、自定义域名等）。
 */

const OSS_CREDENTIAL_KEYS = [
  'OSS_REGION',
  'OSS_BUCKET',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
] as const;

/** 四个必填项齐全才算启用了 OSS，否则回退本地磁盘。 */
export function ossEnabled() {
  return OSS_CREDENTIAL_KEYS.every((key) => process.env[key]);
}

/** Bucket 名与 Region 名允许的字符，防止环境变量写错污染 CSP 响应头。 */
const SAFE_HOST_PART = /^[a-z0-9][a-z0-9-]*$/i;

/** 解析成 origin（`https://host[:port]`），非法地址返回 null。 */
function parseOrigin(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** 配置了 OSS_ENDPOINT 就返回原值（ali-oss 会自行补协议），非法则忽略。 */
export function ossEndpoint() {
  const raw = process.env.OSS_ENDPOINT?.trim();
  if (!raw || !parseOrigin(raw)) return null;
  return raw;
}

/** 需要放行到 CSP 的 OSS origin 列表：自定义 endpoint 优先，其次是默认公网域名。 */
export function ossOrigins() {
  if (!ossEnabled()) return [];
  const origins: string[] = [];
  const publicOrigin = parseOrigin(process.env.OSS_PUBLIC_BASE_URL?.trim() ?? '');
  if (process.env.OSS_PUBLIC_BASE_URL?.trim() && publicOrigin) origins.push(publicOrigin);
  const endpointOrigin = parseOrigin(process.env.OSS_ENDPOINT?.trim() ?? '');
  if (endpointOrigin) origins.push(endpointOrigin);
  const bucket = process.env.OSS_BUCKET?.trim() ?? '';
  const region = process.env.OSS_REGION?.trim() ?? '';
  if (SAFE_HOST_PART.test(bucket) && SAFE_HOST_PART.test(region)) {
    origins.push(`https://${bucket}.${region}.aliyuncs.com`);
  }
  return [...new Set(origins)];
}
