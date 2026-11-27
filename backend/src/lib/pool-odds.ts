export const POOL_PRICING = 'POOL';
export const NO_OPPOSITION = 'NO_OPPOSITION';
export const POOL_MIN_SIDE_STAKE = 50;
export const BET_MAX_ORDINARY_STAKE = 500;
export const POOL_MAX_ODDS = 20;
const POOL_VOID_LABELS = {
  NO_OPPOSITION: '未形成双边下注',
  INSUFFICIENT_POOL: '任一方奖池未满 ' + POOL_MIN_SIDE_STAKE + ' 币',
  ODDS_LIMIT: '奖池差距使赔率超出 ' + POOL_MAX_ODDS + ' 倍',
} as const;

export function poolVoidLabel(reason?: string | null) {
  return reason && Object.hasOwn(POOL_VOID_LABELS, reason)
    ? POOL_VOID_LABELS[reason as keyof typeof POOL_VOID_LABELS]
    : null;
}
const RATE_SCALE = 10000;

export function poolQuote(own: number, other: number, returnRate: number) {
  const denominator = BigInt(Math.max(1, own)) * BigInt(RATE_SCALE);
  const profit = BigInt(other) * BigInt(Math.round(returnRate * RATE_SCALE));
  const capped = BigInt(POOL_MAX_ODDS - 1) * denominator;
  const numerator = own && other ? denominator + (profit < capped ? profit : capped) : denominator;
  return {
    overLimit: Boolean(own && other) && profit > capped,
    numerator,
    denominator,
    odds: Number(numerator) / Number(denominator),
  };
}

export function poolVoidReason(one: number, two: number, returnRate: number) {
  const smaller = Math.min(one, two);
  if (smaller === 0) return NO_OPPOSITION;
  if (smaller < POOL_MIN_SIDE_STAKE) return 'INSUFFICIENT_POOL';
  if (poolQuote(smaller, Math.max(one, two), returnRate).overLimit) return 'ODDS_LIMIT';
  return null;
}

export function poolPayout(stake: number, own: number, other: number, returnRate: number) {
  const { numerator, denominator } = poolQuote(own, other, returnRate);
  return Math.min(2_147_483_647, Number((BigInt(stake) * numerator) / denominator));
}
