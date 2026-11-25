import type { MatchGameRecord, PlayerProfile, User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { settleGameMarketsForMatch } from '@/server/market-settlement';
import { parseFavoriteHeroes } from '@/lib/favorite-heroes';
import { championNameById, itemIdFromInput } from '@/lib/game-assets';
import { ApiError } from '@/server/api';
import { assertCanManageUser, statusStillBlocked } from '@/server/permissions';

/**
 * 对局战绩的写入与聚合（迁移自原 Flask 服务的 MatchResult 相关接口与
 * _all_players 统计逻辑）。
 *
 * 战绩是胜场 / KDA / MVP 的唯一数据源：选手页、排行页与个人主页的统计
 * 全部由这里现算，避免出现「赛果已录入但选手数据不更新」的情况。
 */

/** 将后台位置和 Riot/LCU 的位置名归一为本站的五个位置槽。 */
export function normalizeTeamPosition(value: unknown) {
  const position = String(value ?? '')
    .trim()
    .toUpperCase();
  const aliases: Record<string, string> = {
    TOP: 'TOP',
    JUG: 'JUG',
    JUNGLE: 'JUG',
    MID: 'MID',
    MIDDLE: 'MID',
    ADC: 'ADC',
    BOTTOM: 'ADC',
    BOT: 'ADC',
    SUP: 'SUP',
    SUPPORT: 'SUP',
    UTILITY: 'SUP',
  };
  return aliases[position] ?? '';
}

export async function listMatchRecords(matchId: number) {
  const records = await prisma.matchGameRecord.findMany({
    where: { matchId },
    orderBy: [{ gameNo: 'asc' }, { id: 'asc' }],
    include: { user: { select: { username: true, profile: { select: { gameName: true } } } } },
  });
  return records.map((record) => ({
    id: record.id,
    user_id: record.userId,
    username: record.user?.username ?? '已注销',
    game_name: record.user?.profile?.gameName ?? '',
    champion: record.champion,
    result: record.result,
    team_rank: record.teamRank,
    level: record.level,
    kills: record.kills,
    deaths: record.deaths,
    assists: record.assists,
    cs: record.cs,
    gold: record.gold,
    vision: record.vision,
    damage_to_champions: record.damageToChampions,
    items: record.items ? record.items.split(',').filter(Boolean) : [],
    team_pos: record.teamPosition,
    is_mvp: record.isMvp,
    is_svp: record.isSvp,
    game_no: record.gameNo,
    round_no: record.roundNo,
    played_at: record.playedAt ? record.playedAt.toISOString().slice(0, 10) : '',
  }));
}

export async function listSeasonMatchRecords(seasonMatchId: number) {
  const records = await prisma.matchGameRecord.findMany({
    where: { seasonMatchId },
    orderBy: [{ gameNo: 'asc' }, { id: 'asc' }],
    include: { user: { select: { username: true, profile: { select: { gameName: true } } } } },
  });
  return records.map((record) => ({
    id: record.id,
    user_id: record.userId,
    username: record.user?.username ?? '已注销',
    game_name: record.user?.profile?.gameName ?? '',
    champion: record.champion,
    result: record.result,
    team_rank: record.teamRank,
    level: record.level,
    kills: record.kills,
    deaths: record.deaths,
    assists: record.assists,
    cs: record.cs,
    gold: record.gold,
    vision: record.vision,
    damage_to_champions: record.damageToChampions,
    items: record.items ? record.items.split(',').filter(Boolean) : [],
    team_pos: record.teamPosition,
    is_mvp: record.isMvp,
    is_svp: record.isSvp,
    game_no: record.gameNo,
    round_no: record.roundNo,
    played_at: record.playedAt ? record.playedAt.toISOString().slice(0, 10) : '',
  }));
}

export async function listUserRecords(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true },
  });
  if (!user) return { kind: 'not_found' as const };

  const records = await prisma.matchGameRecord.findMany({
    where: { userId },
    orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
  });
  const matchIds = records
    .map((record) => record.matchId)
    .filter((id): id is number => typeof id === 'number');
  const matches = await prisma.match.findMany({
    where: { id: { in: [...new Set(matchIds)] } },
    select: { id: true, name: true },
  });
  const names = new Map(matches.map((match) => [match.id, match.name]));

  return {
    kind: 'ok' as const,
    username: user.username,
    records: records.map((record) => ({
      id: record.id,
      match_id: record.matchId,
      match_name: record.matchId ? (names.get(record.matchId) ?? '自由对局') : '自由对局',
      game_no: record.gameNo,
      champion: record.champion,
      result: record.result,
      kills: record.kills,
      deaths: record.deaths,
      assists: record.assists,
      is_mvp: record.isMvp,
      played_at: record.playedAt ? record.playedAt.toISOString().slice(0, 10) : '',
    })),
  };
}

export async function clearUserRecords(userId: number, actorId: number) {
  // 管理员只能清普通选手的战绩，不能动其他管理员。
  await assertCanManageUser(actorId, userId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true },
  });
  if (!user) return { kind: 'not_found' as const };
  const { count } = await prisma.matchGameRecord.deleteMany({ where: { userId } });
  return { kind: 'ok' as const, username: user.username, deleted: count };
}

/** 对局详情：按 比赛 + 小局 查该局所有选手。 */
export async function gameDetail(matchId: number, gameNo: number) {
  const rows = await prisma.matchGameRecord.findMany({
    where: { matchId, gameNo },
    include: {
      user: { select: { username: true, profile: { select: { avatar: true, rank: true } } } },
    },
  });
  if (!rows.length) return { kind: 'empty' as const };

  const match = await prisma.match.findUnique({ where: { id: matchId } });
  const players = rows
    .map((record) => ({
      username: record.user?.username ?? '',
      avatar: record.user?.profile?.avatar ?? '',
      rank: record.user?.profile?.rank ?? '',
      champion: record.champion,
      result: record.result,
      kills: record.kills,
      deaths: record.deaths,
      assists: record.assists,
      kda: record.deaths
        ? Number(((record.kills + record.assists) / record.deaths).toFixed(2))
        : record.kills + record.assists,
      is_mvp: record.isMvp,
      is_svp: record.isSvp,
      level: record.level,
      cs: record.cs,
      gold: record.gold,
      vision: record.vision,
      damageToChampions: record.damageToChampions,
    }))
    .sort((a, b) => {
      if (a.result !== b.result) return a.result === 'win' ? -1 : 1;
      return Number(b.is_mvp || b.is_svp) - Number(a.is_mvp || a.is_svp);
    });

  return {
    kind: 'ok' as const,
    matchName: match?.name ?? '自由对局',
    matchId,
    gameNo,
    players,
  };
}

type RankedRecord = Pick<
  MatchGameRecord,
  | 'matchId'
  | 'seasonMatchId'
  | 'playedAt'
  | 'createdAt'
  | 'champion'
  | 'result'
  | 'kills'
  | 'deaths'
  | 'assists'
  | 'teamPosition'
  | 'isMvp'
  | 'isSvp'
  | 'teamRank'
>;

export type PlayerStats = {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  kda: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  mvp: number;
  svp: number;
  fmvp: number;
  teamChampion: number;
  runnerup: number;
  mvpRate: number;
  points: number;
  hero: string;
  recent: string;
};

const round = (value: number, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 战绩聚合：与原服务 _all_players 的统计口径保持一致。 */
export function summarize(
  records: RankedRecord[],
  fmvp = 0,
  placements?: { champion: number; runnerup: number },
): PlayerStats {
  const games = records.length;
  const wins = records.filter((record) => record.result === 'win').length;
  const losses = games - wins;
  const sumKills = records.reduce((sum, record) => sum + record.kills, 0);
  const sumDeaths = records.reduce((sum, record) => sum + record.deaths, 0);
  const sumAssists = records.reduce((sum, record) => sum + record.assists, 0);
  const mvp = records.filter((record) => record.isMvp).length;
  const svp = records.filter((record) => record.isSvp).length;
  const supportWins = records.filter(
    (record) => record.result === 'win' && normalizeTeamPosition(record.teamPosition) === 'SUP',
  ).length;
  // 冠亚军：优先采用赛事固化的名次（placementCounts，来自 championTeamId/runnerupTeamId + 报名），
  // 这样即使没录入单局战绩也能正确展示荣誉；未传入时退回按战绩 teamRank 统计。
  const placementCount = (teamRank: 1 | 2) => {
    const matches = new Set<number>();
    let standalone = 0;
    for (const record of records) {
      if (record.teamRank !== teamRank) continue;
      if (record.matchId === null) standalone += 1;
      else matches.add(record.matchId);
    }
    return matches.size + standalone;
  };
  const teamChampion = placements ? placements.champion : placementCount(1);
  const runnerup = placements ? placements.runnerup : placementCount(2);

  const championCount = new Map<string, number>();
  for (const record of records) {
    if (!record.champion) continue;
    championCount.set(record.champion, (championCount.get(record.champion) ?? 0) + 1);
  }
  const hero = [...championCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const points = Math.max(
    0,
    wins * 10 -
      losses * 5 +
      supportWins * 5 +
      mvp * 8 +
      svp * 5 +
      fmvp * 10 +
      teamChampion * 30 +
      runnerup * 15,
  );

  return {
    games,
    wins,
    losses,
    winRate: games ? round((wins * 100) / games) : 0,
    kda: sumDeaths ? round((sumKills + sumAssists) / sumDeaths, 2) : 0,
    avgKills: games ? round(sumKills / games, 1) : 0,
    avgDeaths: games ? round(sumDeaths / games, 1) : 0,
    avgAssists: games ? round(sumAssists / games, 1) : 0,
    mvp,
    svp,
    fmvp,
    teamChampion,
    runnerup,
    mvpRate: games ? round((mvp * 100) / games) : 0,
    points,
    hero,
    recent: records
      .slice(0, 10)
      .map((record) => (record.result === 'win' ? 'W' : 'L'))
      .join(' '),
  };
}

type ProfileWithUser = PlayerProfile & {
  user: Pick<User, 'username' | 'kookName' | 'backgroundImage' | 'avatarFrame'>;
};

export function toPlayer(
  profile: ProfileWithUser,
  records: RankedRecord[],
  fmvp = 0,
  placements?: { champion: number; runnerup: number },
) {
  // records 需按时间倒序传入，用于取「最近 10 场」序列。
  const stats = summarize(records, fmvp, placements);
  return {
    id: profile.userId,
    name: profile.name || profile.user.username,
    username: profile.user.username,
    gameName: profile.gameName,
    title: '',
    position: profile.mainPosition,
    mainPosition: profile.mainPosition,
    subPosition: profile.subPosition,
    rank: profile.rank,
    bio: profile.bio,
    avatar: profile.avatar,
    avatarFrame: profile.user.avatarFrame,
    favoriteHeroes: parseFavoriteHeroes(profile.favoriteHeroes),
    kookName: profile.user.kookName,
    background: profile.user.backgroundImage,
    wins: stats.wins,
    losses: stats.losses,
    winRate: stats.winRate,
    kda: stats.kda,
    mvp: stats.mvp,
    svp: stats.svp,
    fmvp: stats.fmvp,
    games: stats.games,
    points: stats.points,
    teamChampion: stats.teamChampion,
    runnerup: stats.runnerup,
    mvpRate: stats.mvpRate,
    avgKills: stats.avgKills,
    avgDeaths: stats.avgDeaths,
    avgAssists: stats.avgAssists,
    hero: stats.hero,
    recent: stats.recent,
  };
}

export type PlayerCard = ReturnType<typeof toPlayer>;

type PlacementCounts = Map<number, { champion: number; runnerup: number }>;

const bumpPlacement = (counts: PlacementCounts, userId: number, rank: 1 | 2) => {
  const entry = counts.get(userId) ?? { champion: 0, runnerup: 0 };
  if (rank === 1) entry.champion += 1;
  else entry.runnerup += 1;
  counts.set(userId, entry);
};

/** 战绩里手工标注的冠亚军：自由对局逐条计，赛事内按 matchId 去重（已固化冠亚军的赛事跳过）。 */
function manualPlacementEntries(
  records: Pick<MatchGameRecord, 'userId' | 'teamRank' | 'matchId'>[],
  finishedIds: Set<number>,
) {
  const entries: { userId: number; rank: 1 | 2 }[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.teamRank !== 1 && record.teamRank !== 2) continue;
    if (record.matchId !== null) {
      if (finishedIds.has(record.matchId)) continue;
      const key = `${record.matchId}-${record.userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    entries.push({ userId: record.userId, rank: record.teamRank === 1 ? 1 : 2 });
  }
  return entries;
}

/**
 * 统计每位选手的冠军 / 亚军次数。
 *
 * 以「赛事固化的冠亚军队伍（championTeamId / runnerupTeamId + 报名）」为权威来源，
 * 即使只录了团队比分、没有录入单局战绩，选手也能在荣誉里看到名次；
 * 再补上战绩里手工标注的名次（自由对局 + 未固化冠亚军的赛事），按 matchId 去重避免重复计数。
 */
export async function placementCounts(userIds?: number[]) {
  const counts: PlacementCounts = new Map();
  const bump = (userId: number, rank: 1 | 2) => bumpPlacement(counts, userId, rank);

  const userFilter = userIds?.length ? { userId: { in: userIds } } : {};

  // 1) 已结束赛事的固化冠亚军（权威来源，覆盖「只录比分没录战绩」的场景）。
  const finished = await prisma.match.findMany({
    where: { championTeamId: { not: null }, runnerupTeamId: { not: null } },
    select: { id: true, championTeamId: true, runnerupTeamId: true },
  });
  const finishedIds = new Set<number>();
  if (finished.length) {
    for (const match of finished) finishedIds.add(match.id);
    const signups = await prisma.matchSignup.findMany({
      where: { matchId: { in: [...finishedIds] }, ...userFilter },
      select: { userId: true, matchId: true, teamId: true },
    });
    const championTeamByMatch = new Map(finished.map((match) => [match.id, match.championTeamId!]));
    const runnerupTeamByMatch = new Map(finished.map((match) => [match.id, match.runnerupTeamId!]));
    for (const signup of signups) {
      if (signup.teamId === championTeamByMatch.get(signup.matchId)) bump(signup.userId, 1);
      else if (signup.teamId === runnerupTeamByMatch.get(signup.matchId)) bump(signup.userId, 2);
    }
  }

  // 2) 战绩里的手工名次：只补「自由对局（matchId 空）」与「赛事未固化冠亚军」的记录。
  const manual = await prisma.matchGameRecord.findMany({
    where: { teamRank: { in: [1, 2] }, ...userFilter },
    select: { userId: true, teamRank: true, matchId: true },
  });
  for (const entry of manualPlacementEntries(manual, finishedIds)) {
    bump(entry.userId, entry.rank);
  }

  // 3) 战队赛冠亚军：TeamSeasonTeam.finalRank 1/2 的战队成员（独立于常规赛荣誉）。
  const seasonTeams = await prisma.teamSeasonTeam.findMany({
    where: { finalRank: { in: [1, 2] } },
    select: { id: true, finalRank: true },
  });
  if (seasonTeams.length) {
    const seasonTeamIds = seasonTeams.map((team) => team.id);
    const rankByTeam = new Map(seasonTeams.map((team) => [team.id, team.finalRank]));
    const members = await prisma.teamSeasonMember.findMany({
      where: { teamId: { in: seasonTeamIds }, ...userFilter },
      select: { userId: true, teamId: true },
    });
    for (const member of members) {
      const rank = rankByTeam.get(member.teamId);
      if (rank === 1) bump(member.userId, 1);
      else if (rank === 2) bump(member.userId, 2);
    }
  }

  return counts;
}

/** 排行榜的统计周期：周榜（周一 ~ 周日）与月榜（自然月），按比赛日期归属。 */
export type RankingPeriod = 'week' | 'month';

/** 周期区间：start / end 是北京时间的首末日期（含），startAt / endAt 是过滤用的瞬时（左闭右开）。 */
export type RankingPeriodRange = {
  key: RankingPeriod;
  start: string;
  end: string;
  startAt: Date;
  endAt: Date;
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad2 = (value: number) => String(value).padStart(2, '0');

/** 周期按北京时间切分：服务端跑在 UTC 时，直接把 0 点的比赛算到前一天。 */
const beijingParts = (value: Date) => {
  const shifted = new Date(value.getTime() + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
};

const beijingDateText = (value: Date) => {
  const { year, month, day } = beijingParts(value);
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

/** 北京时间某天 0 点对应的瞬时。 */
const beijingMidnight = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS);

/** 本周（周一 ~ 周日）或本月的区间。 */
export function rankingPeriodRange(period: RankingPeriod, now = new Date()): RankingPeriodRange {
  const { year, month, day, weekday } = beijingParts(now);
  // getUTCDay() 里 0 是周日，这里换算成「距周一几天」。
  const startAt =
    period === 'week'
      ? beijingMidnight(year, month, day - ((weekday + 6) % 7))
      : beijingMidnight(year, month, 1);
  const endAt =
    period === 'week'
      ? new Date(startAt.getTime() + 7 * 24 * 60 * 60 * 1000)
      : beijingMidnight(year, month + 1, 1);
  return {
    key: period,
    start: beijingDateText(startAt),
    end: beijingDateText(new Date(endAt.getTime() - 1)),
    startAt,
    endAt,
  };
}

/** 周期榜的过滤上下文：期内比赛的日期索引、期内 FMVP 次数与期内冠亚军加分。 */
type PeriodContext = {
  startAt: Date;
  endAt: Date;
  /** 常规赛赛事 ID → 归属日期（排期优先，未排期退回创建时间） */
  matchDates: Map<number, Date>;
  /** 战队赛场次 ID → 归属日期 */
  seasonDates: Map<number, Date>;
  /** 期内已固化冠亚军的赛事 ID，用于避免与手工名次重复加分 */
  finishedIds: Set<number>;
  fmvpByUser: Map<number, number>;
  placements: PlacementCounts;
};

/**
 * 一条战绩归属哪个周期：常规赛按赛事排期（未排期退回赛事创建时间），
 * 战队赛按场次排期，自由对局按对局时间；都没有时退回记录创建时间。
 */
function recordPeriodDate(record: RankedRecord, context: PeriodContext): Date {
  if (record.matchId !== null) {
    const date = context.matchDates.get(record.matchId);
    if (date) return date;
  }
  if (record.seasonMatchId !== null) {
    const date = context.seasonDates.get(record.seasonMatchId);
    if (date) return date;
  }
  return record.playedAt ?? record.createdAt;
}

/** 期内的赛事日期、FMVP 与冠亚军加分：口径与全量榜单一致，只是限定在本周期内的比赛。 */
async function periodContext(range: RankingPeriodRange): Promise<PeriodContext> {
  const [matches, seasonMatches, seasonFinals] = await Promise.all([
    prisma.match.findMany({
      select: {
        id: true,
        date: true,
        createdAt: true,
        fmvpUserId: true,
        championTeamId: true,
        runnerupTeamId: true,
      },
    }),
    prisma.teamSeasonMatch.findMany({ select: { id: true, scheduledAt: true } }),
    // 战队赛荣誉没有赛果表，只能按决赛场次的排期归属。
    prisma.teamSeasonMatch.findMany({
      where: { phase: 'PLAYOFF', stage: 'FINAL', status: 'FINISHED' },
      select: { seasonId: true, scheduledAt: true },
    }),
  ]);

  const inRange = (value: Date) => value >= range.startAt && value < range.endAt;
  const matchDates = new Map(matches.map((match) => [match.id, match.date ?? match.createdAt]));
  const seasonDates = new Map(seasonMatches.map((match) => [match.id, match.scheduledAt]));

  const finished = matches.filter(
    (match) =>
      inRange(matchDates.get(match.id) ?? match.createdAt) &&
      match.championTeamId !== null &&
      match.runnerupTeamId !== null,
  );
  const fmvpByUser = new Map<number, number>();
  for (const match of matches) {
    if (match.fmvpUserId === null) continue;
    if (!inRange(matchDates.get(match.id) ?? match.createdAt)) continue;
    fmvpByUser.set(match.fmvpUserId, (fmvpByUser.get(match.fmvpUserId) ?? 0) + 1);
  }

  // 期内已结束赛事的固化冠亚军：即使选手没录单局战绩也能拿到加分。
  const placements: PlacementCounts = new Map();
  const finishedIds = new Set(finished.map((match) => match.id));
  if (finished.length) {
    const championTeamByMatch = new Map(finished.map((match) => [match.id, match.championTeamId!]));
    const runnerupTeamByMatch = new Map(finished.map((match) => [match.id, match.runnerupTeamId!]));
    const signups = await prisma.matchSignup.findMany({
      where: { matchId: { in: [...finishedIds] } },
      select: { userId: true, matchId: true, teamId: true },
    });
    for (const signup of signups) {
      if (signup.teamId === championTeamByMatch.get(signup.matchId))
        bumpPlacement(placements, signup.userId, 1);
      else if (signup.teamId === runnerupTeamByMatch.get(signup.matchId))
        bumpPlacement(placements, signup.userId, 2);
    }
  }

  // 战队赛决赛的冠亚军也按决赛日期归属：名次以 finalRank 为准，与全量榜单同一口径。
  const finalSeasonIds = [
    ...new Set(
      seasonFinals.filter((match) => inRange(match.scheduledAt)).map((match) => match.seasonId),
    ),
  ];
  if (finalSeasonIds.length) {
    const honourTeams = await prisma.teamSeasonTeam.findMany({
      where: { seasonId: { in: finalSeasonIds }, finalRank: { in: [1, 2] } },
      select: { id: true, finalRank: true },
    });
    if (honourTeams.length) {
      const rankByTeam = new Map(honourTeams.map((team) => [team.id, team.finalRank]));
      const members = await prisma.teamSeasonMember.findMany({
        where: { teamId: { in: [...rankByTeam.keys()] } },
        select: { userId: true, teamId: true },
      });
      for (const member of members) {
        const rank = rankByTeam.get(member.teamId);
        if (rank === 1) bumpPlacement(placements, member.userId, 1);
        else if (rank === 2) bumpPlacement(placements, member.userId, 2);
      }
    }
  }

  return {
    startAt: range.startAt,
    endAt: range.endAt,
    matchDates,
    seasonDates,
    finishedIds,
    fmvpByUser,
    placements,
  };
}

/** 选手榜单的筛选与排序条件（选手页服务端分页用；不传时返回全量榜单）。 */
export type PlayerListQuery = {
  /** 关键词：只匹配用户名（昵称/账户ID）与游戏昵称（召唤师名） */
  keyword?: string;
  /** 段位精确筛选（与前端口径一致：空段位按 "none" 比较） */
  rank?: string;
  /** 位置精确筛选 */
  position?: string;
  /** 最低场次筛选 */
  minGames?: number;
  /** 积分排序方向：desc 从高到低（默认），asc 从低到高 */
  order?: 'desc' | 'asc';
  /** 统计周期：不传即历史总榜；传 "week" / "month" 只统计本周期内比赛的战绩与荣誉 */
  period?: RankingPeriod;
  /** 周期起点参考时间；仅用于让接口与调用方共用同一次「现在」，默认取当前时间 */
  now?: Date;
};

/** 全部选手（含未参赛账号），按积分降序。只有核心管理员的系统账号不在其中。
    query 可选，用于把选手页的筛选 / 排序下推到服务端（分页在接口层切片）；
    传 period 时只统计该周期内比赛产生的战绩与荣誉，口径与总榜一致。 */
/** 批量取一批用户的当前生效称号：以佩戴状态（User.title）为准。 */
export async function activeTitleMap(userIds: number[]): Promise<Map<number, string>> {
  if (!userIds.length) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, title: true },
  });
  const map = new Map<number, string>();
  for (const user of users) {
    if (user.title) map.set(user.id, user.title);
  }
  return map;
}

export async function listPlayerCards(query: PlayerListQuery = {}) {
  const period = query.period;
  const range = period ? rankingPeriodRange(period, query.now ?? new Date()) : null;
  // 周期榜要先知道「哪些比赛属于本周期」，才能据此筛战绩与荣誉加分。
  const context = range ? await periodContext(range) : null;

  const [profiles, records, fmvpRows, placements] = await Promise.all([
    prisma.playerProfile.findMany({
      where: {
        // 未绑定游戏昵称（gameName 为空）的账号不出现在选手列表/排行榜中。
        gameName: { not: '' },
        user: {
          is: {
            // 待审核账号尚未通过审核，不出现在选手列表与首页注册选手统计中。
            status: { not: 'PENDING' },
            // 隐藏自己的账号不出现在选手卡片/排行榜等公开榜单中。
            hiddenFromPlayers: false,
          },
        },
      },
      include: {
        user: {
          select: {
            username: true,
            kookName: true,
            backgroundImage: true,
            avatarFrame: true,
            status: true,
          },
        },
      },
    }),
    prisma.matchGameRecord.findMany({
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
      // 榜单只读统计字段，不传输装备、截图导入指标等完整战绩内容。
      select: {
        userId: true,
        matchId: true,
        seasonMatchId: true,
        playedAt: true,
        createdAt: true,
        champion: true,
        result: true,
        kills: true,
        deaths: true,
        assists: true,
        teamPosition: true,
        isMvp: true,
        isSvp: true,
        teamRank: true,
      },
    }),
    context
      ? Promise.resolve([] as { fmvpUserId: number | null; _count: { _all: number } }[])
      : prisma.match.groupBy({
          by: ['fmvpUserId'],
          where: { fmvpUserId: { not: null } },
          _count: { _all: true },
        }),
    context ? Promise.resolve(context.placements) : placementCounts(),
  ]);

  const scoped =
    context && range
      ? records.filter((record) => {
          const date = recordPeriodDate(record, context);
          return date >= range.startAt && date < range.endAt;
        })
      : records;

  const byUser = new Map<number, RankedRecord[]>();
  for (const record of scoped) {
    const bucket = byUser.get(record.userId) ?? [];
    bucket.push(record);
    byUser.set(record.userId, bucket);
  }
  const fmvpByUser = context
    ? context.fmvpByUser
    : new Map(
        fmvpRows.flatMap((row) =>
          row.fmvpUserId === null ? [] : [[row.fmvpUserId, row._count._all]],
        ),
      );

  if (context) {
    // 期内战绩里手工标注的名次同样计入（自由对局 + 赛事未固化冠亚军的记录）。
    for (const entry of manualPlacementEntries(scoped, context.finishedIds)) {
      bumpPlacement(placements, entry.userId, entry.rank);
    }
  }

  let cards = profiles
    .map((profile) =>
      toPlayer(
        profile,
        byUser.get(profile.userId) ?? [],
        fmvpByUser.get(profile.userId) ?? 0,
        placements.get(profile.userId),
      ),
    )
    // 榜单排序：积分优先，同积分比胜率，同胜率比 KDA；最后用 id 兜底保证顺序稳定。
    .sort((a, b) => b.points - a.points || b.winRate - a.winRate || b.kda - a.kda || a.id - b.id);

  // 各筛选条件相互独立、可叠加，逐条过滤而不是命中一个就返回。
  // 关键词只认「用户名」与「游戏昵称」：位置、段位、KOOK 名、用户ID 都有各自的筛选/展示，
  // 混进关键词会让搜「TOP」「大师」这类词时带出一堆无关选手。
  const keyword = query.keyword?.trim().toLowerCase();
  if (keyword) {
    cards = cards.filter(
      (player) =>
        player.name.toLowerCase().includes(keyword) ||
        player.username.toLowerCase().includes(keyword) ||
        player.gameName.toLowerCase().includes(keyword),
    );
  }
  if (query.rank) {
    cards = cards.filter((player) => (player.rank || 'none') === query.rank);
  }
  if (query.position) {
    cards = cards.filter((player) => player.position === query.position);
  }
  const minGames = query.minGames;
  if (minGames) {
    cards = cards.filter((player) => player.games >= minGames);
  }
  // 为选手卡片批量补上当前生效称号。
  const titleMap = await activeTitleMap(cards.map((card) => card.id));
  for (const card of cards) card.title = titleMap.get(card.id) ?? '';
  if (query.order === 'asc') {
    return [...cards].sort(
      (a, b) => a.points - b.points || b.winRate - a.winRate || b.kda - a.kda || a.id - b.id,
    );
  }
  return cards;
}

export async function playerCardByUserId(userId: number) {
  const profile = await prisma.playerProfile.findFirst({
    where: { userId, user: { is: { hiddenFromPlayers: false } } },
    include: {
      user: {
        select: { username: true, kookName: true, backgroundImage: true, avatarFrame: true },
      },
    },
  });
  if (!profile) return null;
  const [records, fmvp, placements] = await Promise.all([
    prisma.matchGameRecord.findMany({
      where: { userId },
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.match.count({ where: { fmvpUserId: userId } }),
    placementCounts([userId]),
  ]);
  const player = toPlayer(profile, records, fmvp, placements.get(userId));
  player.title = (await activeTitleMap([userId])).get(userId) ?? '';
  return player;
}

/**
 * 个人主页：统计 + 常用英雄 TOP3 + 全部对局历史（含参战率）。
 * 隐藏自己的账号（hiddenFromPlayers）只在本人查看时可见，其他人查看返回不存在。
 */
export async function profileOverview(userId: number, includeHidden = false) {
  const profile = await prisma.playerProfile.findFirst({
    where: {
      userId,
      user: { is: includeHidden ? {} : { hiddenFromPlayers: false } },
    },
    include: {
      user: {
        select: { username: true, kookName: true, backgroundImage: true, avatarFrame: true },
      },
    },
  });
  if (!profile) return null;

  const [records, fmvp, placements] = await Promise.all([
    prisma.matchGameRecord.findMany({
      where: { userId },
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.match.count({ where: { fmvpUserId: userId } }),
    placementCounts([userId]),
  ]);
  const matchIds = records
    .map((record) => record.matchId)
    .filter((id): id is number => typeof id === 'number');
  const matches = await prisma.match.findMany({
    where: { id: { in: [...new Set(matchIds)] } },
    select: { id: true, name: true },
  });
  const names = new Map(matches.map((match) => [match.id, match.name]));
  const seasonMatchIds = records
    .map((record) => record.seasonMatchId)
    .filter((id): id is number => typeof id === 'number');
  const seasonMatches = seasonMatchIds.length
    ? await prisma.teamSeasonMatch.findMany({
        where: { id: { in: [...new Set(seasonMatchIds)] } },
        select: { id: true, season: { select: { name: true } } },
      })
    : [];
  const seasonNameById = new Map(seasonMatches.map((item) => [item.id, item.season.name]));

  // 参战率 = (击杀+助攻) / 同场次同局同队的击杀总和，上限 100%（与赛果页口径一致）。
  // 战绩的 teamId 可能为空（手工录入与旧版自动导入），此时回落到报名时的队伍。
  const signupTeams = matchIds.length
    ? await prisma.matchSignup.findMany({
        where: { matchId: { in: [...new Set(matchIds)] } },
        select: { matchId: true, userId: true, teamId: true },
      })
    : [];
  const signupTeamByUserMatch = new Map(
    signupTeams.map((signup) => [`${signup.matchId}-${signup.userId}`, signup.teamId]),
  );
  const teamIdOf = (record: { matchId: number | null; userId: number; teamId: number | null }) =>
    record.teamId ??
    (record.matchId === null
      ? null
      : (signupTeamByUserMatch.get(`${record.matchId}-${record.userId}`) ?? null));
  const scopeKey = (row: {
    matchId: number | null;
    roundNo: number;
    gameNo: number;
    teamId: number | null;
  }) => `${row.matchId ?? 0}-${row.roundNo}-${row.gameNo}-${row.teamId ?? 0}`;
  const scopes = new Map<
    string,
    { matchId: number; roundNo: number; gameNo: number; teamId: number }
  >();
  for (const record of records) {
    const teamId = teamIdOf(record);
    if (record.matchId === null || teamId === null) continue;
    scopes.set(scopeKey(record), {
      matchId: record.matchId,
      roundNo: record.roundNo,
      gameNo: record.gameNo,
      teamId,
    });
  }
  const teamKills = new Map<string, number>();
  if (scopes.size) {
    const rows = await prisma.matchGameRecord.findMany({
      where: {
        OR: [...scopes.values()].map(({ matchId, roundNo, gameNo }) => ({
          matchId,
          roundNo,
          gameNo,
        })),
      },
      select: {
        matchId: true,
        userId: true,
        roundNo: true,
        gameNo: true,
        teamId: true,
        kills: true,
      },
    });
    for (const row of rows) {
      const teamId = teamIdOf(row);
      if (row.matchId === null || teamId === null) continue;
      const key = scopeKey({ ...row, teamId });
      teamKills.set(key, (teamKills.get(key) ?? 0) + row.kills);
    }
  }

  const heroes = new Map<
    string,
    { games: number; wins: number; kills: number; deaths: number; assists: number }
  >();
  for (const record of records) {
    if (!record.champion) continue;
    const entry = heroes.get(record.champion) ?? {
      games: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
    };
    entry.games += 1;
    entry.wins += record.result === 'win' ? 1 : 0;
    entry.kills += record.kills;
    entry.deaths += record.deaths;
    entry.assists += record.assists;
    heroes.set(record.champion, entry);
  }

  const placement = placements.get(userId);
  const card = toPlayer(profile, records, fmvp, placement);

  return {
    player: card,
    stats: summarize(records, fmvp, placement),
    heroes: [...heroes.entries()]
      .sort((a, b) => b[1].games - a[1].games)
      .slice(0, 3)
      .map(([champion, entry]) => ({
        champion,
        games: entry.games,
        win_rate: entry.games ? round((entry.wins * 100) / entry.games) : 0,
        kda: entry.deaths ? round((entry.kills + entry.assists) / entry.deaths, 2) : 0,
      })),
    history: records.map((record) => ({
      id: record.id,
      match_id: record.matchId,
      match_name: record.seasonMatchId
        ? (seasonNameById.get(record.seasonMatchId) ?? '战队赛')
        : record.matchId
          ? (names.get(record.matchId) ?? '自由对局')
          : '自由对局',
      champion: record.champion,
      result: record.result,
      kills: record.kills,
      deaths: record.deaths,
      assists: record.assists,
      kda: record.deaths
        ? round((record.kills + record.assists) / record.deaths, 2)
        : record.kills + record.assists,
      played_at: record.playedAt ? record.playedAt.toISOString() : null,
      game_no: record.gameNo,
      round_no: record.roundNo,
      team_id: teamIdOf(record),
      level: record.level,
      cs: record.cs,
      vision: record.vision,
      gold: record.gold,
      items: record.items ? record.items.split(',').filter(Boolean) : [],
      team_pos: record.teamPosition,
      is_mvp: record.isMvp,
      is_svp: record.isSvp,
      participation: (() => {
        const teamId = teamIdOf(record);
        const total =
          teamId === null
            ? 0
            : (teamKills.get(
                scopeKey({
                  matchId: record.matchId,
                  roundNo: record.roundNo,
                  gameNo: record.gameNo,
                  teamId,
                }),
              ) ?? 0);
        if (!total) return 0;
        return Math.min(100, round(((record.kills + record.assists) * 100) / total));
      })(),
    })),
  };
}

/** 首页「最近赛果」与冠军数统计。 */
export async function recentResults(limit = 8) {
  const records = await prisma.matchGameRecord.findMany({
    orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    include: { user: { select: { username: true, profile: { select: { avatar: true } } } } },
  });
  return records.map((record) => ({
    id: record.id,
    nickname: record.user?.username ?? '未知',
    avatar: record.user?.profile?.avatar ?? '',
    champion: record.champion,
    result: record.result,
    kills: record.kills,
    deaths: record.deaths,
    assists: record.assists,
    is_mvp: record.isMvp,
    is_svp: record.isSvp,
    team_rank: record.teamRank,
    played_at: record.playedAt ? record.playedAt.toISOString().slice(0, 10) : '',
  }));
}

export async function championCount() {
  const placements = await placementCounts();
  let count = 0;
  for (const placement of placements.values()) {
    if (placement.champion > 0) count += 1;
  }
  return count;
}
