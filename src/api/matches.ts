import { post, request } from './client';

export const SIX_TEAM_FORMAT = '六队模式';
export const SIX_TEAM_FORMAT_V2 = '六队模式2.0';
export const EIGHT_TEAM_FORMAT = '八队模式';
export const EIGHT_TEAM_FORMAT_V2 = '八队模式2.0';
export const BO_OPTIONS = [
  'BO1',
  'BO3',
  'BO5',
  SIX_TEAM_FORMAT,
  SIX_TEAM_FORMAT_V2,
  EIGHT_TEAM_FORMAT,
  EIGHT_TEAM_FORMAT_V2,
];
export const MATCH_STATUSES = ['CREATED', 'LIVE', 'FINISHED'] as const;

/** 按赛制和轮次返回本轮 BO；普通 BO 赛制直接原样返回。 */
export function boForRound(format: string, roundNo: number) {
  if (format === SIX_TEAM_FORMAT) return roundNo === 2 ? 'BO1' : 'BO3';
  if (format === SIX_TEAM_FORMAT_V2) return roundNo >= 3 ? 'BO5' : 'BO3';
  if (format === EIGHT_TEAM_FORMAT) return roundNo >= 3 ? 'BO5' : 'BO3';
  if (format === EIGHT_TEAM_FORMAT_V2) return roundNo === 2 ? 'BO1' : 'BO3';
  return format;
}

export const BO_WINS: Record<string, number> = { BO1: 1, BO2: 2, BO3: 2, BO5: 3 };

const BO_VALID_SCORES: Record<string, [number, number][]> = {
  BO1: [
    [1, 0],
    [0, 1],
  ],
  BO2: [
    [2, 0],
    [0, 2],
    [1, 1],
  ],
  BO3: [
    [2, 0],
    [0, 2],
    [2, 1],
    [1, 2],
  ],
  BO5: [
    [3, 0],
    [0, 3],
    [3, 1],
    [1, 3],
    [3, 2],
    [2, 3],
  ],
};

export function isValidBoScore(bo: string, scoreOne: number, scoreTwo: number): boolean {
  const valid = BO_VALID_SCORES[bo];
  return Boolean(valid) && valid.some(([a, b]) => a === scoreOne && b === scoreTwo);
}

export function boScoreHint(bo: string): string {
  if (bo === 'BO1') return 'BO1 的比分只能是 1-0';
  if (bo === 'BO2') return 'BO2 的比分只能是 2-0、0-2 或 1-1';
  if (bo === 'BO3') return 'BO3 的比分只能是 2-0 或 2-1';
  if (bo === 'BO5') return 'BO5 的比分只能是 3-0、3-1 或 3-2';
  return '比分不符合当前赛制';
}

function roundTitle(roundNo: number, totalRounds: number, format = '') {
  if (format === SIX_TEAM_FORMAT) {
    if (roundNo === 1) return '六强赛';
    if (roundNo === 2) return '半决赛';
    if (roundNo === 3) return '决赛';
  }
  if (format === SIX_TEAM_FORMAT_V2) {
    if (roundNo === 1) return '六进四';
    if (roundNo === 2) return '四进二';
    if (roundNo === 3) return '决赛';
  }
  const fromFinal = totalRounds - roundNo;
  if (fromFinal === 0) return '决赛';
  if (fromFinal === 1) return '半决赛';
  if (fromFinal === 2) return '四分之一决赛';
  if (fromFinal === 3) return '八分之一决赛';
  if (fromFinal === 4) return '十六分之一决赛';
  return `第 ${roundNo} 轮`;
}

export function roundLabel(roundNo: number, totalRounds: number, format = '') {
  const title = roundTitle(roundNo, totalRounds, format);
  if (format !== EIGHT_TEAM_FORMAT && format !== SIX_TEAM_FORMAT_V2) return title;
  return `${roundNo >= 3 ? '第二天' : '第一天'} · ${title}`;
}

export const PRIZE_PLACE_LABELS: Record<number, string> = {
  1: '冠军',
  2: '亚军',
  4: '四强',
  6: '六强',
  8: '八强',
  16: '十六强',
  32: '三十二强',
};

export const DEFAULT_PRIZE_POOL: Record<number, number> = {
  1: 300,
  2: 150,
  4: 80,
  8: 40,
  16: 20,
};

export function prizePoolFromJson(json: string): Record<number, number> {
  try {
    const raw = JSON.parse(json || '{}') as Record<string, unknown>;
    const pool: Record<number, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      const place = Number(key);
      if (!(place in PRIZE_PLACE_LABELS)) continue;
      if (value === undefined || value === null || value === '') continue;
      const amount = Number(value);
      if (!Number.isInteger(amount) || amount < 0 || amount > 1_000_000) continue;
      pool[place] = amount;
    }
    return pool;
  } catch {
    return {};
  }
}

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

type ScorePair = { teamOneId: number; teamTwoId: number; scoreOne: number; scoreTwo: number };

/** 逐组保存比分；全部录入且需要晋级时调用结束本轮，失败不丢失已保存比分。 */
export async function submitRoundScores(input: {
  matchId: number;
  roundNo: number;
  pairs: ScorePair[];
  remaining: number;
  advance: boolean;
}): Promise<{ msg?: string; advanceError?: string }> {
  for (const { teamOneId, teamTwoId, scoreOne, scoreTwo } of input.pairs) {
    await post('/api/admin/match/score', {
      matchId: input.matchId,
      roundNo: input.roundNo,
      teamOneId,
      teamTwoId,
      scoreOne,
      scoreTwo,
    });
  }
  if (input.remaining > 0) return { msg: `战果已保存，还有 ${input.remaining} 组对阵待录入` };
  if (!input.advance) return { msg: '战果已保存' };
  try {
    return await post(`/api/admin/match/round/end/${input.matchId}`, { roundNo: input.roundNo });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '请核对最新赛事状态';
    return {
      msg: '战果已保存',
      advanceError: `自动晋级未完成：${reason}。可使用「结束本轮」重试。`,
    };
  }
}

export type BoardTeam = {
  id: number;
  match_id: number;
  name: string;
  sort_order: number;
  draft_order: number;
  logo?: string;
  player_count: number;
  used_fee: number;
};
export type BoardSign = {
  id: number;
  user_id: number;
  username: string;
  yy_name: string;
  game_name: string;
  avatar: string;
  rank: string;
  main_pos: string;
  sub_pos: string;
  team_id: number | null;
  team_pos: string;
  pos_order: number;
  is_captain: boolean;
};
export type MatchBoard = {
  match: {
    id: number;
    name: string;
    status: string;
    use_fee: boolean;
    bo: string;
    total_rounds: number;
    champion_team_id: number | null;
    captain_position: string;
    round: string;
    date: string | null;
    live_url: string | null;
    prize_pool_json: string;
    prize_distributed: boolean;
    team_count: number;
  };
  teams: BoardTeam[];
  signs: BoardSign[];
  current_round: number;
  round_ended: boolean;
  has_score: boolean;
  round_pairs: {
    team_one: number;
    team_two: number;
    score_one: number;
    score_two: number;
    has_score: boolean;
  }[];
  budget: number;
  fmvp: {
    user_id: number;
    username: string;
    game_name: string;
    avatar: string;
  } | null;
};

export function fetchMatchBoard(id: number) {
  return request<MatchBoard>(`/api/admin/teams/${id}`);
}
