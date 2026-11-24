/** Visible pages only, one request at a time, with timeout and failure backoff. */
export function pollLiveJson<T>(
  url: string,
  onData: (data: T) => void,
  events: string[] = [],
  options: { immediate?: boolean; onError?: () => void } = {},
) {
  let disposed = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let pending = false;
  const active = () => !disposed && !document.hidden && navigator.onLine;
  function schedule() {
    clearTimeout(timer);
    if (active()) timer = setTimeout(run, Math.min(10_000 * 2 ** failures, 60_000));
  }
  async function run() {
    clearTimeout(timer);
    if (!active() || controller) return;
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), 10_000);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error('Live update failed');
      const data: T = await response.json();
      // An event received during this request requires a fresh read before publishing.
      if (!disposed && !request.signal.aborted && !pending) onData(data);
      failures = 0;
    } catch {
      if (active()) {
        failures = Math.min(failures + 1, 3);
        options.onError?.();
      }
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      if (pending && active()) {
        pending = false;
        void run();
      } else schedule();
    }
  }
  function resume() {
    clearTimeout(timer);
    if (active()) {
      if (controller) pending = true;
      else void run();
    } else controller?.abort();
  }
  const windowEvents = ['focus', 'online', 'offline', ...events];
  document.addEventListener('visibilitychange', resume);
  for (const event of windowEvents) window.addEventListener(event, resume);
  if (options.immediate) void run();
  else schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
    controller?.abort();
    document.removeEventListener('visibilitychange', resume);
    for (const event of windowEvents) window.removeEventListener(event, resume);
  };
}
