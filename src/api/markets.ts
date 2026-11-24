export type Outcome = { id: number; outcomeKey: string; label: string; odds: number; prob: number };
export type MarketSource = {
  name: string;
  kind: string;
  pair?: string | null;
  teams?: { name: string; logo: string }[];
};
export type Market = {
  id: number;
  matchId: number | null;
  seasonMatchId: number | null;
  marketKind: string;
  roundNo: number | null;
  teamOneId: number | null;
  teamTwoId: number | null;
  status: string;
  bettingCloseAt: string;
  source: MarketSource;
  outcomes: Outcome[];
};
export type Pairing = { roundNo: number; teamOneId: number; teamTwoId: number; label: string };
export type MarketMatch = {
  id: number;
  name: string;
  date: string | null;
  status: string;
  bo?: string;
  pairings?: Pairing[];
};
export type MarketList = {
  markets: Market[];
  regular: MarketMatch[];
  season: MarketMatch[];
  total: number;
  page: number;
  pageSize: number;
};
export type Bet = {
  id: number;
  userId: number;
  username: string;
  gameName: string;
  outcomeLabel: string;
  stake: number;
  odds_at_bet: number;
  potential_payout: number;
  status: string;
  settled_payout: number;
  createdAt: string;
};
export type MarketBets = {
  totalPool: number;
  totalBets: number;
  market: Market;
  outcomes: (Outcome & { totalStake: number; betCount: number })[];
  bets: Bet[];
};
export type OpenBody = {
  matchId?: number;
  seasonMatchId?: number;
  teamOneId?: number;
  teamTwoId?: number;
  roundNo?: number;
};

export const pairingKey = (pair: Pairing) => `${pair.roundNo}:${pair.teamOneId}:${pair.teamTwoId}`;
const gameCounts: Record<string, number> = { BO1: 1, BO2: 2, BO3: 3, BO5: 5 };
export const gameCount = (bo?: string) => gameCounts[bo || ''] || 0;
export const marketRound = (market: Pick<Market, 'marketKind' | 'roundNo'>) =>
  market.marketKind === 'GAME_WIN' && market.roundNo ? `第 ${market.roundNo} 局` : '大场';
export function recentMarketDates(now = new Date()): [string, string] {
  const shifted = now.getTime() + 8 * 3_600_000;
  return [
    new Date(shifted - 86_400_000).toISOString().slice(0, 10),
    new Date(shifted).toISOString().slice(0, 10),
  ];
}
export function openMarketBody(
  kind: 'REGULAR' | 'SEASON',
  match: MarketMatch | undefined,
  selectedPair: string | undefined,
  round: number,
): OpenBody {
  if (!match) throw new Error('请先选择比赛');
  if (kind === 'SEASON') {
    if (round !== 0) throw new Error('战队赛暂不支持分小场');
    return { seasonMatchId: match.id };
  }
  const pairs = match.pairings || [];
  const pair =
    pairs.find((pair) => pairingKey(pair) === selectedPair) ||
    (pairs.length === 1 ? pairs[0] : undefined);
  if (!pair)
    throw new Error(pairs.length ? '请选择要开盘的对阵' : '该赛事尚未确定对阵，请先完成分队开赛');
  if (!Number.isInteger(round) || round < 0 || round > gameCount(match.bo))
    throw new Error('所选赛制不支持该小场局次');
  return {
    matchId: match.id,
    teamOneId: pair.teamOneId,
    teamTwoId: pair.teamTwoId,
    ...(round > 0 ? { roundNo: round } : {}),
  };
}
export function reopenMarketBody(market: Market): OpenBody {
  if (!['OPEN', 'CLOSED'].includes(market.status))
    throw new Error('已结算或作废的盘口不能重新开盘');
  if (market.matchId != null) {
    if (market.teamOneId == null || market.teamTwoId == null)
      throw new Error('盘口缺少对阵信息，请从开盘表单选择完整对阵');
    return {
      matchId: market.matchId,
      teamOneId: market.teamOneId,
      teamTwoId: market.teamTwoId,
      ...(market.roundNo != null ? { roundNo: market.roundNo } : {}),
    };
  }
  if (market.seasonMatchId == null) throw new Error('盘口缺少赛事信息');
  return { seasonMatchId: market.seasonMatchId };
}
