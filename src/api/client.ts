export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('接口地址必须以 /api/ 开头');
  const timeout = AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json', ...options.headers },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      timeout.aborted ? '请求超时，请检查服务后重试' : '无法连接业务服务，请检查后台代理配置',
      0,
    );
  }
  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('session-expired'));
  }
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok || data?.ok === false) {
    throw new ApiError(
      data?.error || data?.msg || `请求失败（${response.status}）`,
      response.status,
    );
  }
  if (!isJson || !data) throw new ApiError('业务服务返回格式异常，请检查接口代理', response.status);
  return data as T;
}

export function post<T = { msg?: string }>(path: string, body: unknown = {}) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function params(values: Record<string, string | number | undefined>) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') result.set(key, String(value));
  return result.toString();
}
