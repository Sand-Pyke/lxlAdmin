import { request } from './client';

export type SeasonMember = {
  id: number;
  team_id: number;
  user_id: number;
  role: string;
  position: string;
  username: string;
  game_name: string;
  rank: string;
  avatar: string;
};
export type SeasonTeam = {
  id: number;
  name: string;
  abbr: string;
  logo: string;
  division: string;
  starter_fee: number;
  sub_fee: number;
  total_fee: number;
  final_rank: number | null;
  members: SeasonMember[];
};
export type SeasonStandingRow = {
  team_id: number;
  name: string;
  abbr: string;
  logo: string;
  division: string;
  match_wins: number;
  match_losses: number;
  wins: number;
  losses: number;
  points: number;
};
export type SwissStandingRow = {
  team_id: number;
  name: string;
  abbr: string;
  logo: string;
  wins: number;
  losses: number;
  game_wins: number;
  game_losses: number;
  diff: number;
};
export type SeasonMatch = {
  id: number;
  phase: string;
  day_of_week: number;
  round_no: number;
  bo: string;
  stage: string | null;
  status: string;
  scheduled_at: string;
  team_one_id: number;
  team_two_id: number;
  team_one: { id: number; name: string; abbr: string; logo: string } | null;
  team_two: { id: number; name: string; abbr: string; logo: string } | null;
  score_one: number;
  score_two: number;
  record_count: number;
  records_confirmed: boolean;
  substitutions: {
    team_id: number;
    starter_user_id: number;
    substitute_user_id: number;
    position: string;
  }[];
};
export type SeasonBoard = {
  season: {
    id: number;
    name: string;
    status: string;
    start_date: string | null;
    prize_pool_json: string;
    prize_distributed: boolean;
  };
  teams: SeasonTeam[];
  pool: SeasonMember[];
  standings: SeasonStandingRow[];
  swiss_standings: SwissStandingRow[];
  matches: SeasonMatch[];
};

export const SEASON_STATUS_LABEL: Record<string, string> = {
  SIGNUPS: '报名中',
  DRAFTING: '待选人',
  POINTS: '积分赛',
  SWISS: '瑞士轮',
  PLAYOFFS: '淘汰赛',
  FINISHED: '已结束',
};
export const DIVISION_LABEL: Record<string, string> = {
  APEX: '登峰组',
  NIRVANA: '涅槃组',
};
export const STAGE_LABEL: Record<string, string> = {
  SEMIFINAL: '半决赛',
  THIRD: '季军赛',
  FINAL: '决赛',
  NIRVANA_SEMIFINAL: '涅槃组四强',
};

export function seasonMatchStageLabel(match: {
  phase: string;
  round_no: number;
  stage: string | null;
}): string {
  if (match.phase === 'POINTS') return `第 ${match.round_no} 轮`;
  if (match.phase === 'SWISS') return `瑞士轮 第 ${match.round_no} 轮`;
  return (match.stage ? STAGE_LABEL[match.stage] : '') || '淘汰赛';
}

const TIME_ZONE = 'Asia/Shanghai';
const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const dayFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

export type ScheduleSlotGroup<T> = { key: string; label: string; matches: T[] };

const dayLabel = (value: Date) => {
  const parts = new Map(
    dayFormatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get('month')}/${parts.get('day')} ${parts.get('weekday')}`;
};

export function groupByScheduleSlot<T extends { scheduled_at: string | null }>(
  matches: T[],
): ScheduleSlotGroup<T>[] {
  const buckets = new Map<string, { label: string; sortKey: number; matches: T[] }>();
  for (const match of matches) {
    const date = match.scheduled_at ? new Date(match.scheduled_at) : null;
    if (!date || Number.isNaN(date.getTime())) {
      const bucket = buckets.get('unset') ?? {
        label: '时间待定',
        sortKey: Number.MAX_SAFE_INTEGER,
        matches: [],
      };
      bucket.matches.push(match);
      buckets.set('unset', bucket);
      continue;
    }
    const time = timeFormatter.format(date);
    const key = `${dateKeyFormatter.format(date)} ${time}`;
    const bucket = buckets.get(key) ?? { label: `${dayLabel(date)} ${time}`, sortKey: date.getTime(), matches: [] };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([, a], [, b]) => a.sortKey - b.sortKey)
    .map(([key, bucket]) => ({ key, label: bucket.label, matches: bucket.matches }));
}

export function fetchSeasonBoard(id: number) {
  return request<SeasonBoard>(`/api/admin/season/board/${id}`);
}
