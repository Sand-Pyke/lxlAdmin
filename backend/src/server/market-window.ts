export const MARKET_WINDOW_MS = 15 * 60_000;

/** Updating live odds keeps the original deadline; reopening starts a new window. */
export function resolveMarketCloseAt(existing: Date | null, now = Date.now()): Date {
  return existing && existing.getTime() > now ? existing : new Date(now + MARKET_WINDOW_MS);
}
