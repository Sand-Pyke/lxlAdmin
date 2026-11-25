import { SIX_TEAM_FORMAT, SIX_TEAM_FORMAT_V2 } from '@/lib/admin-options';

/**
 * 冠军池纯工具（客户端可安全引用，不依赖 Prisma/服务端）。
 * 配置以 JSON 存储，key 为名次档（1冠军/2亚军/4四强/6六强/8八强/16十六强/32三十二强），
 * value 为该档每位队员所得冠军币。
 */

export const PRIZE_PLACE_LABELS: Record<number, string> = {
  1: '冠军',
  2: '亚军',
  4: '四强',
  6: '六强',
  8: '八强',
  16: '十六强',
  32: '三十二强',
};

/** 默认冠军池（每人）：冠军 300 / 亚军 150 / 四强 80 / 八强 40 / 十六强 20。 */
export const DEFAULT_PRIZE_POOL: Record<number, number> = {
  1: 300,
  2: 150,
  4: 80,
  8: 40,
  16: 20,
};

const VALID_PLACES = new Set(Object.keys(PRIZE_PLACE_LABELS).map(Number));

/** 解析并校验冠军池配置：非法金额抛 Error（服务端再转成业务错误）。 */
export function parsePrizePool(input: unknown): Record<number, number> {
  const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const pool: Record<number, number> = {};
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const place = Number(rawKey);
    if (!VALID_PLACES.has(place)) continue;
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const amount = Number(rawValue);
    if (!Number.isInteger(amount) || amount < 0 || amount > 1_000_000)
      throw new Error(`${PRIZE_PLACE_LABELS[place]}金额需为 0~1000000 的整数`);
    pool[place] = amount;
  }
  return pool;
}

export function serializePrizePool(pool: Record<number, number>): string {
  return JSON.stringify(pool);
}

export function prizePoolFromJson(json: string): Record<number, number> {
  try {
    return parsePrizePool(JSON.parse(json || '{}') as Record<string, unknown>);
  } catch {
    return {};
  }
}

/**
 * 冠军池展示用条目：只保留设置了金额的名次档，按名次从高到低（冠军在前）排列。
 * 赛事信息页与后台共用，避免两处各写一遍排序与兜底标签。
 */
export function prizePoolEntries(json: string): { place: number; label: string; amount: number }[] {
  return Object.entries(prizePoolFromJson(json))
    .map(([place, amount]) => ({ place: Number(place), amount }))
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => a.place - b.place)
    .map((entry) => ({
      ...entry,
      label: PRIZE_PLACE_LABELS[entry.place] ?? `${entry.place} 强`,
    }));
}

/** 战队赛最终名次（finalRank）→ 名次档：3/4 名记四强、5~8 名记八强、9~16 名记十六强。 */
export function placeForFinalRank(rank: number): number {
  if (rank <= 1) return 1;
  if (rank <= 2) return 2;
  if (rank <= 4) return 4;
  if (rank <= 8) return 8;
  if (rank <= 16) return 16;
  return 32;
}

/** 常规赛可配置的名次档（按赛制与队伍数推导，用于后台编辑表单）。 */
export function applicableRegularTiers(
  bo: string,
  teamCount: number,
): { place: number; label: string }[] {
  const tiers: { place: number; label: string }[] = [
    { place: 1, label: '冠军' },
    { place: 2, label: '亚军' },
  ];
  if (bo === SIX_TEAM_FORMAT || bo === SIX_TEAM_FORMAT_V2) {
    tiers.push({ place: 4, label: '四强' }, { place: 6, label: '六强' });
    return tiers;
  }
  if (teamCount >= 4) tiers.push({ place: 4, label: '四强' });
  if (teamCount >= 8) tiers.push({ place: 8, label: '八强' });
  if (teamCount >= 16) tiers.push({ place: 16, label: '十六强' });
  if (teamCount >= 32) tiers.push({ place: 32, label: '三十二强' });
  return tiers;
}

/** 战队赛可配置的名次档（按参赛队伍数推导）。 */
export function seasonTiers(teamCount: number): { place: number; label: string }[] {
  const tiers: { place: number; label: string }[] = [
    { place: 1, label: '冠军' },
    { place: 2, label: '亚军' },
    { place: 4, label: '四强' },
    { place: 8, label: '八强' },
  ];
  if (teamCount > 8) tiers.push({ place: 16, label: '十六强' });
  if (teamCount > 16) tiers.push({ place: 32, label: '三十二强' });
  return tiers;
}
