import { prisma } from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';
import { ApiError, badRequest, forbidden, notFound } from '@/server/api';
import { getSessionUser, getViewer } from '@/server/auth';
import { assertSecondaryAdmin, isCoreAdminActor } from '@/server/permissions';
import { RANKS, boScoreHint, isValidBoScore } from '@/lib/admin-options';
import { missingSignupRequirements } from '@/lib/profile-requirements';
import { banNotice } from '@/lib/ban';
import { readUpload } from '@/server/account';
import { imageContentType, putUploadedImage } from '@/server/uploads';
import { rankFee } from '@/server/roster';
import { settleMarketsForSeasonScore } from '@/server/market-settlement';
import { distributeSeasonPrizes } from '@/server/prize';
import { activeTitleMap } from '@/server/records';
import { activeNameplatesForUsers } from '@/server/nameplates';

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const shanghaiDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function datePartsInShanghai(date: Date) {
  return new Map(
    shanghaiDateTimeFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

/** 将上海时区的本地时间转换为瞬时时间，不依赖 Node 进程的时区配置。 */
function shanghaiDateTime(year: number, month: number, day: number, hour: number, minute: number) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = targetAsUtc;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = datePartsInShanghai(new Date(timestamp));
    const actualAsUtc = Date.UTC(
      parts.get('year')!,
      parts.get('month')! - 1,
      parts.get('day')!,
      parts.get('hour')!,
      parts.get('minute')!,
      parts.get('second')!,
    );
    timestamp = targetAsUtc - (actualAsUtc - timestamp);
  }
  return new Date(timestamp);
}

/** 解析可空排期日期；支持北京时间日期或 ISO 时间，未传/非法返回 null。 */
function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = shanghaiDateTime(year, month, day, 0, 0);
    const parts = datePartsInShanghai(date);
    if (parts.get('year') !== year || parts.get('month') !== month || parts.get('day') !== day)
      return null;
    return date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 严格解析后台提交的北京时间本地日期时间。 */
function parseShanghaiDateTime(value: unknown): Date {
  if (typeof value !== 'string') throw badRequest('请选择有效的开赛时间');
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw badRequest('开赛时间格式无效');

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() + 1 !== month ||
    calendarDate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    throw badRequest('开赛时间无效');
  }

  const date = shanghaiDateTime(year, month, day, hour, minute);
  const parts = datePartsInShanghai(date);
  if (
    parts.get('year') !== year ||
    parts.get('month') !== month ||
    parts.get('day') !== day ||
    parts.get('hour') !== hour ||
    parts.get('minute') !== minute
  ) {
    throw badRequest('开赛时间无效');
  }
  return date;
}

/** 把 base 平移 dayOffset 天，并把时间定到指定的北京时间。 */
function atTimeOfDay(base: Date, dayOffset: number, hour: number, minute: number): Date {
  const parts = datePartsInShanghai(base);
  const targetDate = new Date(
    Date.UTC(parts.get('year')!, parts.get('month')! - 1, parts.get('day')! + dayOffset),
  );
  return shanghaiDateTime(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth() + 1,
    targetDate.getUTCDate(),
    hour,
    minute,
  );
}

/** 赛程起始日按其所在周的周六对齐；周日归到前一天的周六。 */
function firstSaturdayOfWeek(base: Date): Date {
  const parts = datePartsInShanghai(base);
  const date = new Date(Date.UTC(parts.get('year')!, parts.get('month')! - 1, parts.get('day')!));
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -1 : 6 - weekday));
  return shanghaiDateTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0);
}

/**
 * 赛制时间轴（基准日 = 第 1 周周六，即 startDate）：
 * 第 1 周：涅槃组单循环选拔（连续 5 天，每晚 20:00，每天一轮）；第 2 周：瑞士轮（周六 R1+R2、周日 R3）；
 * 第 3 周：淘汰赛（周六半决赛，周日季军赛+决赛）。
 */
const SEASON_SLOTS = {
  week2Saturday: { dayOffset: 7, hour: 19, minute: 30 },
  week2Sunday: { dayOffset: 8, hour: 19, minute: 30 },
  week3Saturday: { dayOffset: 14, hour: 19, minute: 30 },
  week3Sunday: { dayOffset: 15, hour: 19, minute: 30 },
} as const;

const slotTime = (slot: (typeof SEASON_SLOTS)[keyof typeof SEASON_SLOTS], base: Date) =>
  atTimeOfDay(firstSaturdayOfWeek(base), slot.dayOffset, slot.hour, slot.minute);

export type SeasonPair<T> = [T, T | null];

/**
 * 圆桌轮转法生成 N 队单循环对阵；奇数队自动补「轮空」位（[a, null] 表示 a 轮空）。
 * 保证任意两队最多交手一次、每队每轮只打一场。
 */
export function roundRobinRounds<T>(items: T[]): SeasonPair<T>[][] {
  const n = items.length;
  if (n < 2) return [];
  const withBye = n % 2 === 1;
  const slots: (T | null)[] = withBye ? [null, ...items] : [...items];
  const m = slots.length; // 偶数
  const fixed = slots[0];
  const rotating = slots.slice(1);
  const totalRounds = m - 1;

  const rounds: SeasonPair<T>[][] = [];
  for (let round = 0; round < totalRounds; round++) {
    const order = [fixed, ...rotating];
    const pairs: SeasonPair<T>[] = [];
    for (let i = 0; i < m / 2; i++) {
      const a = order[i];
      const b = order[m - 1 - i];
      if (a === null) pairs.push([b as T, null]);
      else if (b === null) pairs.push([a, null]);
      else pairs.push([a, b]);
    }
    rounds.push(pairs);
    const last = rotating.pop()!;
    rotating.unshift(last);
  }
  return rounds;
}

type PointsMatchRow = {
  dayOfWeek: number;
  roundNo: number;
  teamOneId: number;
  teamTwoId: number;
  scheduledAt: Date;
};

/**
 * 生成涅槃组选拔单循环：6 队共 5 轮，连续 5 天各一轮，每晚 20:00 开赛（每天每队一个 BO3）。
 * 圆桌轮转法保证任意两队交手一次；奇数队自动补轮空。
 */
export function buildPointsSchedule(teamIds: number[], firstDay: Date): PointsMatchRow[] {
  const rounds = roundRobinRounds(teamIds);
  const firstSaturday = firstSaturdayOfWeek(firstDay);
  const rows: PointsMatchRow[] = [];
  for (const [index, pairs] of rounds.entries()) {
    const scheduledAt = atTimeOfDay(firstSaturday, index, 20, 0);
    for (const [a, b] of pairs) {
      if (b === null) continue;
      rows.push({
        // 第 1 天（周六）起连续排：周六=6、周日=0、周一=1、周二=2、周三=3。
        dayOfWeek: (6 + index) % 7,
        // 轮次全局编号（1 起），跨天连续，便于展示「第 N 轮」。
        roundNo: index + 1,
        teamOneId: a,
        teamTwoId: b,
        scheduledAt,
      });
    }
  }
  return rows;
}

export async function createSeason(body: Record<string, unknown>) {
  const name = asText(body.name);
  if (!name) throw badRequest('战队赛名称不能为空');
  const season = await prisma.teamSeason.create({
    data: {
      name: name.slice(0, 100),
      // 与常规赛「待选人」对齐：创建后即可报名，同时后台可编排队伍、设队长。
      status: 'DRAFTING',
      startDate: parseDate(body.startDate ?? body.date),
    },
  });
  return { msg: '战队赛已创建', id: season.id };
}

/** 按当前队伍生成/重建涅槃组选拔单循环（幂等：先清空旧积分赛再写入）。 */
export async function generateSeasonSchedule(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    include: { teams: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  });
  if (!season) throw notFound('战队赛不存在');

  const ungrouped = season.teams.filter((team) => !team.division);
  if (ungrouped.length) {
    throw badRequest(
      `还有战队未分组（${ungrouped.map((team) => team.name).join('、')}），请先完成登峰组/涅槃组分组`,
    );
  }
  const nirvana = season.teams.filter((team) => team.division === 'NIRVANA');
  if (nirvana.length < 2) throw badRequest('涅槃组至少需要 2 支战队才能进行单循环选拔');

  const firstDay = season.startDate ?? new Date();
  // 登峰组不参与选拔单循环，直接进入瑞士轮；这里只为涅槃组生成单循环。
  const rows = buildPointsSchedule(
    nirvana.map((team) => team.id),
    firstDay,
  );
  if (!rows.length) throw badRequest('没有可生成的赛程');
  await prisma.$transaction([
    prisma.teamSeasonMatch.deleteMany({ where: { seasonId, phase: 'POINTS' } }),
    prisma.teamSeasonMatch.createMany({
      data: rows.map((row, scheduleOrder) => ({
        seasonId,
        phase: 'POINTS' as const,
        dayOfWeek: row.dayOfWeek,
        roundNo: row.roundNo,
        scheduleOrder,
        bo: 'BO3',
        scheduledAt: row.scheduledAt,
        teamOneId: row.teamOneId,
        teamTwoId: row.teamTwoId,
      })),
    }),
  ]);
  return { msg: '涅槃组选拔单循环已生成', count: rows.length };
}

/** 仅修正已生成场次的时间，不改动对阵、比分、战绩或阵容。 */
export async function realignSeasonSchedule(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: {
      startDate: true,
      matches: {
        orderBy: { scheduledAt: 'asc' },
        select: { id: true, phase: true, stage: true, roundNo: true, scheduledAt: true },
      },
    },
  });
  if (!season) throw notFound('战队赛不存在');
  const startDate = season.startDate ?? season.matches[0]?.scheduledAt;
  if (!startDate) throw badRequest('该战队赛没有可用的起始日期或赛程');

  const firstSaturday = firstSaturdayOfWeek(startDate);
  const updates = season.matches.flatMap((match) => {
    let scheduledAt: Date | null = null;
    if (match.phase === 'POINTS') {
      // 涅槃组选拔单循环：第 N 轮排在第 N 天，每晚 20:00。
      scheduledAt = atTimeOfDay(firstSaturday, match.roundNo - 1, 20, 0);
    } else if (match.phase === 'SWISS') {
      // 瑞士轮：R1+R2 周六、R3 周日。
      scheduledAt = slotTime(
        match.roundNo <= 2 ? SEASON_SLOTS.week2Saturday : SEASON_SLOTS.week2Sunday,
        firstSaturday,
      );
    } else if (match.phase === 'PLAYOFF' && match.stage === 'NIRVANA_SEMIFINAL') {
      // 涅槃组四强：第 6 天晚上 20:00 两场 BO5 同时开。
      scheduledAt = atTimeOfDay(firstSaturday, 5, 20, 0);
    } else if (match.phase === 'PLAYOFF' && match.stage === 'SEMIFINAL') {
      scheduledAt = slotTime(SEASON_SLOTS.week3Saturday, firstSaturday);
    } else if (match.phase === 'PLAYOFF' && (match.stage === 'FINAL' || match.stage === 'THIRD')) {
      scheduledAt = slotTime(SEASON_SLOTS.week3Sunday, firstSaturday);
    }
    return scheduledAt ? [{ id: match.id, scheduledAt }] : [];
  });

  await prisma.$transaction(
    updates.map(({ id, scheduledAt }) =>
      prisma.teamSeasonMatch.update({ where: { id }, data: { scheduledAt } }),
    ),
  );
  return {
    msg: `已按北京时间修正 ${updates.length} 场时间；对阵、比分和战绩未改动`,
    count: updates.length,
  };
}

/** 修改单场比赛的开赛时间；提交的日期时间按北京时间解析。 */
export async function updateSeasonMatchSchedule(matchId: number, scheduledAt: unknown) {
  const date = parseShanghaiDateTime(scheduledAt);
  const match = await prisma.teamSeasonMatch.findUnique({
    where: { id: matchId },
    select: { id: true },
  });
  if (!match) throw notFound('战队赛场次不存在');

  await prisma.teamSeasonMatch.update({
    where: { id: matchId },
    data: { scheduledAt: date },
  });
  return { msg: '开赛时间已更新', scheduled_at: date.toISOString() };
}

/** 交换同一战队赛中两场未结束比赛的赛程位置，不修改对阵或战果。 */
export async function swapSeasonMatchSchedule(
  seasonId: number,
  sourceMatchId: number,
  targetMatchId: number,
) {
  if (sourceMatchId === targetMatchId) throw badRequest('请选择另一场赛程进行对调');

  await prisma.$transaction(async (tx) => {
    const matches = await tx.teamSeasonMatch.findMany({
      where: {
        seasonId,
        id: { in: [sourceMatchId, targetMatchId] },
      },
      select: {
        id: true,
        scheduledAt: true,
        dayOfWeek: true,
        roundNo: true,
        scheduleOrder: true,
        status: true,
      },
    });
    if (matches.length !== 2) throw notFound('赛程不存在或不属于该战队赛');
    if (matches.some((match) => match.status === 'FINISHED')) {
      throw badRequest('已结束的比赛不能调整赛程');
    }

    const byId = new Map(matches.map((match) => [match.id, match]));
    const source = byId.get(sourceMatchId);
    const target = byId.get(targetMatchId);
    if (!source || !target) throw notFound('赛程不存在或不属于该战队赛');
    await Promise.all([
      tx.teamSeasonMatch.update({
        where: { id: sourceMatchId },
        data: {
          scheduledAt: target.scheduledAt,
          dayOfWeek: target.dayOfWeek,
          roundNo: target.roundNo,
          scheduleOrder: target.scheduleOrder,
        },
      }),
      tx.teamSeasonMatch.update({
        where: { id: targetMatchId },
        data: {
          scheduledAt: source.scheduledAt,
          dayOfWeek: source.dayOfWeek,
          roundNo: source.roundNo,
          scheduleOrder: source.scheduleOrder,
        },
      }),
    ]);
  });

  return { msg: '两场赛程已对调' };
}

export async function listSeasons() {
  const seasons = await prisma.teamSeason.findMany({
    orderBy: [{ createdAt: 'desc' }],
    include: { _count: { select: { teams: true, matches: true, signups: true } } },
  });
  return {
    seasons: seasons.map((season) => ({
      id: season.id,
      name: season.name,
      status: season.status,
      start_date: season.startDate?.toISOString() ?? null,
      created_at: season.createdAt.toISOString(),
      team_count: season._count.teams,
      match_count: season._count.matches,
      signup_count: season._count.signups,
    })),
  };
}

const SEASON_POSITIONS = new Set(['TOP', 'JUG', 'MID', 'ADC', 'SUP']);

type SeasonRosterMember = { role: string; position: string; userId?: number };

function isSeasonPositionOccupied(
  members: SeasonRosterMember[],
  position: string,
  excludeUserId?: number,
) {
  const normalizedPosition = position.trim().toUpperCase();
  return members.some(
    (member) =>
      member.role !== 'SUB' &&
      member.userId !== excludeUserId &&
      member.position.trim().toUpperCase() === normalizedPosition,
  );
}

function resolveSeasonJoinRole(
  requestedRole: 'STARTER' | 'SUB',
  members: SeasonRosterMember[],
  position: string,
): 'STARTER' | 'SUB' {
  if (requestedRole === 'SUB') return 'SUB';
  if (
    members.filter((member) => member.role === 'STARTER').length >= 4 ||
    isSeasonPositionOccupied(members, position)
  ) {
    return 'SUB';
  }
  return 'STARTER';
}

/** 校验赛季处于编排阶段（名单未锁定）。 */
async function requireDraftingSeason(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: { id: true, status: true },
  });
  if (!season) throw notFound('战队赛不存在');
  if (season.status !== 'DRAFTING') throw badRequest('名单已锁定，不能再调整');
  return season;
}

/** 紧急更换名单：报名中 / 已结束后不可调整，其余阶段（含开赛后）均允许改动成员。 */
async function requireRosterEditableSeason(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: { id: true, status: true },
  });
  if (!season) throw notFound('战队赛不存在');
  if (season.status === 'SIGNUPS' || season.status === 'FINISHED') {
    throw badRequest('当前状态不能调整名单');
  }
  return season;
}

/** 按成员角色汇总费用：首发（队长+首发）与替补分别统计。 */
function teamFeeBreakdown(members: { role: string; rank: string | null | undefined }[]) {
  let starter = 0;
  let substitute = 0;
  for (const member of members) {
    const fee = rankFee(member.rank);
    if (member.role === 'SUB') substitute += fee;
    else starter += fee;
  }
  return { starter, substitute };
}

/** 按首发费用（队长+首发）对战队自动分组：费用高的一半进登峰组，其余进涅槃组。 */
export async function autoGroupSeasonTeams(seasonId: number) {
  await requireDraftingSeason(seasonId);
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    include: {
      teams: {
        include: { members: { include: { user: { include: { profile: true } } } } },
      },
    },
  });
  if (!season) throw notFound('战队赛不存在');
  if (season.teams.length < 2) throw badRequest('至少需要 2 支战队才能分组');

  const ranked = season.teams.map((team) => ({
    team,
    fee: team.members
      .filter((member) => member.role === 'CAPTAIN' || member.role === 'STARTER')
      .reduce((sum, member) => sum + rankFee(member.user.profile?.rank), 0),
  }));
  ranked.sort(
    (a, b) => b.fee - a.fee || a.team.sortOrder - b.team.sortOrder || a.team.id - b.team.id,
  );
  const apexCount = Math.ceil(ranked.length / 2);
  await prisma.$transaction(
    ranked.map(({ team }, index) =>
      prisma.teamSeasonTeam.update({
        where: { id: team.id },
        data: { division: index < apexCount ? 'APEX' : 'NIRVANA' },
      }),
    ),
  );
  return { msg: '已按首发费用完成分组', grouped: ranked.length };
}

/** 手动调整某支战队的分组（APEX=登峰组 / NIRVANA=涅槃组 / 空=未分组）。 */
export async function setSeasonTeamDivision(teamId: number, division: unknown) {
  const value = division === 'APEX' || division === 'NIRVANA' ? division : '';
  const team = await prisma.teamSeasonTeam.findUnique({
    where: { id: teamId },
    include: { season: { select: { status: true } } },
  });
  if (!team) throw notFound('战队不存在');
  if (team.season.status !== 'DRAFTING') throw badRequest('名单已锁定，不能调整分组');
  await prisma.teamSeasonTeam.update({ where: { id: teamId }, data: { division: value } });
  return { msg: '分组已更新', division: value };
}

/** 编排看板：赛季 + 战队（含成员）+ 可选选手池 + 赛程 + 积分榜。 */
export async function getSeasonBoard(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    include: {
      teams: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: {
          members: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            include: { user: { include: { profile: true } } },
          },
        },
      },
      matches: {
        orderBy: [
          { scheduledAt: 'asc' },
          { scheduleOrder: 'asc' },
          { roundNo: 'asc' },
          { id: 'asc' },
        ],
        include: {
          _count: { select: { records: true } },
          substitutions: {
            select: {
              teamId: true,
              starterUserId: true,
              substituteUserId: true,
              position: true,
            },
          },
        },
      },
    },
  });
  if (!season) throw notFound('战队赛不存在');

  // 选手池：本赛季已报名且尚未入队的选手（后台「分配选手 / 设置队长」从这里选人）。
  const assignedIds = new Set(
    season.teams.flatMap((team) => team.members.map((member) => member.userId)),
  );
  const signups = await prisma.teamSeasonSignup.findMany({
    where: { seasonId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { user: { include: { profile: true } } },
  });

  const teamById = new Map(season.teams.map((team) => [team.id, team]));
  const briefTeam = (teamId: number) => {
    const team = teamById.get(teamId);
    return team ? { id: team.id, name: team.name, abbr: team.abbr, logo: team.logo } : null;
  };

  return {
    season: {
      id: season.id,
      name: season.name,
      status: season.status,
      start_date: season.startDate?.toISOString() ?? null,
      prize_pool_json: season.prizePoolJson,
      prize_distributed: season.prizeDistributed,
    },
    teams: season.teams.map((team) => {
      const fees = teamFeeBreakdown(
        team.members.map((member) => ({
          role: member.role,
          rank: member.user.profile?.rank,
        })),
      );
      return {
        id: team.id,
        name: team.name,
        abbr: team.abbr,
        logo: team.logo,
        sort_order: team.sortOrder,
        division: team.division,
        starter_fee: fees.starter,
        sub_fee: fees.substitute,
        total_fee: fees.starter + fees.substitute,
        final_rank: team.finalRank,
        members: team.members.map((member) => ({
          id: member.id,
          team_id: member.teamId,
          user_id: member.userId,
          role: member.role,
          position: member.position,
          username: member.user.username,
          game_name: member.user.profile?.gameName ?? '',
          rank: member.user.profile?.rank ?? '',
          avatar: member.user.profile?.avatar ?? '',
        })),
      };
    }),
    pool: signups
      .filter((signup) => !assignedIds.has(signup.userId))
      .map((signup) => ({
        user_id: signup.userId,
        username: signup.user.username,
        game_name: signup.user.profile?.gameName ?? '',
        rank: signup.user.profile?.rank ?? '',
        avatar: signup.user.profile?.avatar ?? '',
        main_position: signup.mainPosition,
      })),
    standings: await seasonStandings(seasonId),
    swiss_standings: await swissStandings(seasonId),
    matches: season.matches.map((match) => ({
      id: match.id,
      phase: match.phase,
      day_of_week: match.dayOfWeek,
      round_no: match.roundNo,
      bo: match.bo,
      import_target: match.importTarget,
      stage: match.stage,
      status: match.status,
      scheduled_at: match.scheduledAt.toISOString(),
      team_one_id: match.teamOneId,
      team_two_id: match.teamTwoId,
      team_one: briefTeam(match.teamOneId),
      team_two: briefTeam(match.teamTwoId),
      score_one: match.scoreOne,
      score_two: match.scoreTwo,
      record_count: match._count.records,
      records_confirmed: match.recordsConfirmed,
      substitutions: match.substitutions.map((substitution) => ({
        team_id: substitution.teamId,
        starter_user_id: substitution.starterUserId,
        substitute_user_id: substitution.substituteUserId,
        position: substitution.position,
      })),
    })),
  };
}

/** 保存单场替补调整；只要尚未录入比分就允许修改。支持每队最多 2 名替补同时上场。 */
export async function updateSeasonMatchSubstitutions(
  matchId: number,
  body: Record<string, unknown>,
) {
  const requested = body.substitutions;
  if (!Array.isArray(requested)) throw badRequest('替补调整参数无效');

  const replacements = requested.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const teamId = Number(item.teamId);
    const starterUserId = Number(item.starterUserId);
    const substituteUserId = Number(item.substituteUserId);
    if (
      !Number.isInteger(teamId) ||
      teamId <= 0 ||
      !Number.isInteger(starterUserId) ||
      starterUserId <= 0 ||
      !Number.isInteger(substituteUserId) ||
      substituteUserId <= 0
    ) {
      throw badRequest('替补调整参数无效');
    }
    return { teamId, starterUserId, substituteUserId };
  });

  return prisma.$transaction(
    async (tx) => {
      const match = await tx.teamSeasonMatch.findUnique({
        where: { id: matchId },
        select: {
          id: true,
          teamOneId: true,
          teamTwoId: true,
          scoreOne: true,
          scoreTwo: true,
        },
      });
      if (!match) throw notFound('场次不存在');
      if (match.scoreOne > 0 || match.scoreTwo > 0) {
        throw new ApiError(409, '本场已录入比分，不能再调整对阵');
      }

      const teamIds = [match.teamOneId, match.teamTwoId];
      if (
        replacements.length === 0 ||
        replacements.some((replacement) => !teamIds.includes(replacement.teamId))
      ) {
        throw badRequest('替补调整参数无效');
      }

      const members = await tx.teamSeasonMember.findMany({
        where: { teamId: { in: teamIds }, role: { in: ['CAPTAIN', 'STARTER', 'SUB'] } },
        select: { teamId: true, userId: true, role: true, position: true },
      });
      const toCreate: {
        matchId: number;
        teamId: number;
        starterUserId: number;
        substituteUserId: number;
        position: string;
      }[] = [];
      const usedStarters = new Set<number>();
      const usedSubstitutes = new Set<number>();
      const perTeamCount = new Map<number, number>();
      for (const replacement of replacements) {
        const starter = members.find(
          (member) =>
            member.teamId === replacement.teamId &&
            member.userId === replacement.starterUserId &&
            (member.role === 'STARTER' || member.role === 'CAPTAIN'),
        );
        if (!starter) throw badRequest('请选择该队的一名首发队员或占位队长');
        const substitute = members.find(
          (member) =>
            member.teamId === replacement.teamId &&
            member.userId === replacement.substituteUserId &&
            member.role === 'SUB',
        );
        if (!substitute) throw badRequest('该队没有可上场的替补队员');
        if (starter.position.trim().toUpperCase() !== substitute.position.trim().toUpperCase()) {
          throw badRequest('替补只能顶替相同位置的首发队员');
        }
        if (usedStarters.has(starter.userId)) throw badRequest('同一名首发只能被替换一次');
        if (usedSubstitutes.has(substitute.userId)) throw badRequest('同一名替补只能替换一名首发');
        const count = perTeamCount.get(replacement.teamId) ?? 0;
        if (count >= 2) throw badRequest('每队单场最多启用 2 名替补');
        usedStarters.add(starter.userId);
        usedSubstitutes.add(substitute.userId);
        perTeamCount.set(replacement.teamId, count + 1);
        toCreate.push({
          matchId,
          teamId: replacement.teamId,
          starterUserId: starter.userId,
          substituteUserId: substitute.userId,
          position: substitute.position,
        });
      }

      await tx.teamSeasonMatchSubstitution.deleteMany({ where: { matchId } });
      if (toCreate.length) {
        await tx.teamSeasonMatchSubstitution.createMany({ data: toCreate });
      }
      return { msg: '本场对阵阵容已更新' };
    },
    { isolationLevel: 'Serializable' },
  );
}

/** 战队 Logo 上传：写入 team-logos 存储，返回可访问的相对路径。 */
export async function uploadTeamLogo(adminId: number, file: unknown) {
  const upload = await readUpload(file, undefined, { allowSvg: true });
  if (!upload.ok) throw badRequest(upload.error);
  const name = `t${adminId}_${Date.now()}${upload.ext}`;
  await putUploadedImage('team-logos', name, upload.buffer, imageContentType(name)!);
  return { url: `/assets/team-logos/${name}` };
}

export async function createSeasonTeam(seasonId: number, body: Record<string, unknown>) {
  await requireDraftingSeason(seasonId);
  const name = asText(body.name);
  if (!name) throw badRequest('队名不能为空');
  const count = await prisma.teamSeasonTeam.count({ where: { seasonId } });
  if (count >= 16) throw badRequest('最多 16 支战队');
  const exists = await prisma.teamSeasonTeam.findUnique({
    where: { seasonId_name: { seasonId, name } },
  });
  if (exists) throw badRequest('同名战队已存在');
  const team = await prisma.teamSeasonTeam.create({
    data: {
      seasonId,
      name: name.slice(0, 40),
      abbr: asText(body.abbr).slice(0, 16),
      logo: asText(body.logo).slice(0, 300),
      sortOrder: count,
    },
  });
  return { msg: '战队已创建', id: team.id };
}

export async function updateSeasonTeam(teamId: number, body: Record<string, unknown>) {
  const team = await prisma.teamSeasonTeam.findUnique({
    where: { id: teamId },
    include: { season: { select: { status: true } } },
  });
  if (!team) throw notFound('战队不存在');
  if (team.season.status !== 'DRAFTING') throw badRequest('名单已锁定，不能再调整队伍');

  const name = asText(body.name);
  if (body.name !== undefined && !name) throw badRequest('队名不能为空');
  const data: { name?: string; abbr?: string; logo?: string } = {};
  if (name) data.name = name.slice(0, 40);
  if (body.abbr !== undefined) data.abbr = asText(body.abbr).slice(0, 16);
  if (body.logo !== undefined) data.logo = asText(body.logo).slice(0, 300);
  await prisma.teamSeasonTeam.update({ where: { id: teamId }, data });
  return { msg: '战队已更新' };
}

export async function deleteSeasonTeam(teamId: number) {
  const team = await prisma.teamSeasonTeam.findUnique({
    where: { id: teamId },
    include: { season: { select: { status: true } } },
  });
  if (!team) throw notFound('战队不存在');
  if (team.season.status !== 'DRAFTING') throw badRequest('名单已锁定，不能再调整队伍');
  await prisma.teamSeasonTeam.delete({ where: { id: teamId } });
  return { msg: '战队已删除' };
}

export async function assignSeasonMember(seasonId: number, body: Record<string, unknown>) {
  await requireRosterEditableSeason(seasonId);
  const userId = Number(body.userId);
  const teamId = Number(body.teamId);
  if (!Number.isInteger(userId) || userId < 1) throw badRequest('选手参数无效');
  if (!Number.isInteger(teamId) || teamId < 1) throw badRequest('战队参数无效');

  const roleRaw = typeof body.role === 'string' ? body.role.trim().toUpperCase() : 'CAPTAIN';
  const role: 'CAPTAIN' | 'STARTER' | 'SUB' =
    roleRaw === 'STARTER' || roleRaw === 'SUB' ? roleRaw : 'CAPTAIN';

  const team = await prisma.teamSeasonTeam.findUnique({ where: { id: teamId } });
  if (!team || team.seasonId !== seasonId) throw badRequest('战队不存在或不属于该战队赛');

  // 队员必须来自本赛季报名选手（报名 → 后台/队长组队）。
  const signup = await prisma.teamSeasonSignup.findUnique({
    where: { seasonId_userId: { seasonId, userId } },
  });
  if (!signup) throw badRequest('该选手尚未报名本赛季');

  const positionRaw = typeof body.position === 'string' ? body.position.trim().toUpperCase() : '';
  const position = SEASON_POSITIONS.has(positionRaw)
    ? positionRaw
    : SEASON_POSITIONS.has(signup.mainPosition)
      ? signup.mainPosition
      : 'FILL';

  const members = await prisma.teamSeasonMember.findMany({ where: { teamId } });
  const existing = await prisma.teamSeasonMember.findFirst({
    where: { userId, team: { seasonId } },
  });

  if (role === 'CAPTAIN') {
    const captain = members.find((member) => member.role === 'CAPTAIN');
    if (captain && captain.userId !== userId) throw badRequest('该队已有队长，请先移除原队长');
    const displacedStarter = members.find(
      (member) =>
        member.role === 'STARTER' &&
        member.userId !== userId &&
        member.position.trim().toUpperCase() === position,
    );
    if (
      displacedStarter &&
      members.filter((member) => member.role === 'SUB' && member.userId !== userId).length >= 2
    ) {
      throw badRequest('队长分路已有首发，且替补名额已满，无法设置队长');
    }
    await prisma.$transaction([
      ...(displacedStarter
        ? [
            prisma.teamSeasonMember.update({
              where: { id: displacedStarter.id },
              data: { role: 'SUB' },
            }),
          ]
        : []),
      existing
        ? prisma.teamSeasonMember.update({
            where: { id: existing.id },
            data: { teamId, role, position },
          })
        : prisma.teamSeasonMember.create({ data: { teamId, userId, role, position } }),
    ]);
    return { msg: '已设置队长' };
  }

  if (role === 'STARTER') {
    const occupied = members.some(
      (member) =>
        member.userId !== userId &&
        (member.role === 'CAPTAIN' || member.role === 'STARTER') &&
        member.position.trim().toUpperCase() === position,
    );
    if (occupied) throw badRequest('该位置已有首发/队长，请先移除原队员或换一个位置');
    await prisma.$transaction([
      existing
        ? prisma.teamSeasonMember.update({
            where: { id: existing.id },
            data: { teamId, role, position },
          })
        : prisma.teamSeasonMember.create({ data: { teamId, userId, role, position } }),
    ]);
    return { msg: '已加入首发名单' };
  }

  // 替补：最多 2 名。
  const subs = members.filter((member) => member.role === 'SUB' && member.userId !== userId);
  if (subs.length >= 2) throw badRequest('该队替补已满（最多 2 名）');
  await prisma.$transaction([
    existing
      ? prisma.teamSeasonMember.update({
          where: { id: existing.id },
          data: { teamId, role, position },
        })
      : prisma.teamSeasonMember.create({ data: { teamId, userId, role, position } }),
  ]);
  return { msg: '已加入替补名单' };
}

export async function removeSeasonMember(seasonId: number, body: Record<string, unknown>) {
  await requireRosterEditableSeason(seasonId);
  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId < 1) throw badRequest('选手参数无效');
  const member = await prisma.teamSeasonMember.findFirst({
    where: { userId, team: { seasonId } },
  });
  if (!member) throw badRequest('该选手不在任何战队');
  await prisma.$transaction([
    prisma.teamSeasonMember.delete({ where: { id: member.id } }),
    // 清理该选手在本赛季遗留的替补上场记录，避免出现「无名氏替换无名氏」。
    prisma.teamSeasonMatchSubstitution.deleteMany({
      where: {
        OR: [{ starterUserId: userId }, { substituteUserId: userId }],
        match: { seasonId },
      },
    }),
  ]);
  return { msg: '已移出名单' };
}

/** 锁定名单并生成积分赛赛程：4~16 队，每队 1 队长 + 4 首发（替补可选，最多 2 名）。 */
export async function lockSeasonRoster(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    include: { teams: { include: { members: true } } },
  });
  if (!season) throw notFound('战队赛不存在');
  if (season.status !== 'DRAFTING') throw badRequest('名单已锁定');
  if (season.teams.length < 4) throw badRequest('至少需要 4 支战队');
  if (season.teams.length > 16) throw badRequest('最多 16 支战队');
  // 登峰组/涅槃组分组校验：所有战队都必须分组；涅槃组需至少 2 队打单循环选拔。
  const ungrouped = season.teams.filter((team) => !team.division);
  if (ungrouped.length) {
    throw badRequest(
      `还有战队未分组（${ungrouped.map((team) => team.name).join('、')}），请先完成登峰组/涅槃组分组`,
    );
  }
  if (season.teams.filter((team) => team.division === 'NIRVANA').length < 2) {
    throw badRequest('涅槃组至少需要 2 支战队才能进行单循环选拔');
  }
  const memberRoleUpdates: { id: number; role: 'STARTER' | 'SUB' }[] = [];
  for (const team of season.teams) {
    const members = [...team.members].sort((a, b) => a.id - b.id);
    const captains = members.filter((member) => member.role === 'CAPTAIN');
    if (captains.length !== 1) throw badRequest(`战队「${team.name}」需要且只能有 1 名队长`);

    const occupiedPositions = new Set(
      captains.map((member) => member.position.trim().toUpperCase()),
    );
    const starters = members.filter((member) => member.role === 'STARTER');
    const duplicateStarters = new Set<number>();
    for (const starter of starters) {
      const position = starter.position.trim().toUpperCase();
      if (occupiedPositions.has(position)) duplicateStarters.add(starter.id);
      else occupiedPositions.add(position);
    }

    const substitutes = members.filter(
      (member) => member.role === 'SUB' || duplicateStarters.has(member.id),
    );

    let activeStarters = starters.filter((member) => !duplicateStarters.has(member.id));
    for (const position of SEASON_POSITIONS) {
      if (activeStarters.length >= 4) break;
      if (occupiedPositions.has(position)) continue;
      const promoted = substitutes.find(
        (member) => member.position.trim().toUpperCase() === position,
      );
      if (!promoted) continue;
      activeStarters = [...activeStarters, promoted];
      occupiedPositions.add(position);
    }
    if (activeStarters.length !== 4) {
      throw badRequest(`战队「${team.name}」需要 4 名不同分路的首发`);
    }

    const activeStarterIds = new Set(activeStarters.map((member) => member.id));
    if (substitutes.filter((member) => !activeStarterIds.has(member.id)).length > 2) {
      throw badRequest(`战队「${team.name}」最多 2 名替补`);
    }
    for (const starter of starters) {
      if (!activeStarterIds.has(starter.id))
        memberRoleUpdates.push({ id: starter.id, role: 'SUB' });
    }
    for (const substitute of substitutes) {
      if (activeStarterIds.has(substitute.id))
        memberRoleUpdates.push({ id: substitute.id, role: 'STARTER' });
    }
  }
  await prisma.$transaction([
    ...memberRoleUpdates.map(({ id, role }) =>
      prisma.teamSeasonMember.update({ where: { id }, data: { role } }),
    ),
    prisma.teamSeason.update({ where: { id: seasonId }, data: { status: 'POINTS' } }),
  ]);
  await generateSeasonSchedule(seasonId);
  return { msg: '名单已锁定，积分赛赛程已生成' };
}

export async function deleteSeason(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: { id: true, status: true },
  });
  if (!season) throw notFound('战队赛不存在');
  // 积分赛 / 淘汰赛开始后战队赛正在打（或已打完），删除会连带清掉赛程与全部战绩，
  // 只能在报名中 / 待选人阶段删除。
  if (season.status !== 'SIGNUPS' && season.status !== 'DRAFTING') {
    throw badRequest('战队赛已开始，不能删除');
  }
  await prisma.$transaction([
    prisma.teamSeasonMatch.deleteMany({ where: { seasonId } }),
    prisma.teamSeasonMember.deleteMany({ where: { team: { seasonId } } }),
    prisma.teamSeasonTeam.deleteMany({ where: { seasonId } }),
    prisma.teamSeason.delete({ where: { id: seasonId } }),
  ]);
  return { msg: '战队赛已删除' };
}

export type SeasonStanding = {
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

/** 积分榜：大场胜负按已结束赛程统计，小局积分仍按每局胜 +1、负 -1。 */
export async function seasonStandings(seasonId: number): Promise<SeasonStanding[]> {
  const [teams, matches] = await Promise.all([
    prisma.teamSeasonTeam.findMany({ where: { seasonId } }),
    prisma.teamSeasonMatch.findMany({
      where: { seasonId, phase: 'POINTS', status: 'FINISHED' },
    }),
  ]);
  const stats = new Map<
    number,
    { matchWins: number; matchLosses: number; wins: number; losses: number; diff: number }
  >();
  for (const team of teams) {
    stats.set(team.id, { matchWins: 0, matchLosses: 0, wins: 0, losses: 0, diff: 0 });
  }
  for (const match of matches) {
    const one = stats.get(match.teamOneId);
    const two = stats.get(match.teamTwoId);
    if (!one || !two) continue;
    if (match.scoreOne > match.scoreTwo) {
      one.matchWins += 1;
      two.matchLosses += 1;
    } else if (match.scoreTwo > match.scoreOne) {
      two.matchWins += 1;
      one.matchLosses += 1;
    }
    // 每个小局独立计胜负：1-1 也算 1 胜 1 负，积分 = 小局净胜。
    one.wins += match.scoreOne;
    one.losses += match.scoreTwo;
    two.wins += match.scoreTwo;
    two.losses += match.scoreOne;
    one.diff += match.scoreOne - match.scoreTwo;
    two.diff += match.scoreTwo - match.scoreOne;
  }
  return teams
    .map((team) => {
      const stat = stats.get(team.id)!;
      return {
        team_id: team.id,
        name: team.name,
        abbr: team.abbr,
        logo: team.logo,
        division: team.division,
        match_wins: stat.matchWins,
        match_losses: stat.matchLosses,
        wins: stat.wins,
        losses: stat.losses,
        points: stat.diff,
      };
    })
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.team_id - b.team_id);
}

/** 瑞士轮战绩（仅统计已结束的 SWISS 场次；未进入瑞士轮的队伍不出现在榜单里）。 */
export type SwissStanding = {
  team_id: number;
  name: string;
  abbr: string;
  logo: string;
  wins: number;
  losses: number;
  game_wins: number;
  game_losses: number;
  diff: number;
  opponents: number[];
  beaten: number[];
};

export async function swissStandings(seasonId: number): Promise<SwissStanding[]> {
  const [teams, matches] = await Promise.all([
    prisma.teamSeasonTeam.findMany({ where: { seasonId } }),
    prisma.teamSeasonMatch.findMany({
      where: { seasonId, phase: 'SWISS', status: 'FINISHED' },
    }),
  ]);
  const participantIds = new Set<number>();
  for (const match of matches) {
    participantIds.add(match.teamOneId);
    participantIds.add(match.teamTwoId);
  }
  const stats = new Map<number, SwissStanding>();
  for (const team of teams) {
    if (!participantIds.has(team.id)) continue;
    stats.set(team.id, {
      team_id: team.id,
      name: team.name,
      abbr: team.abbr,
      logo: team.logo,
      wins: 0,
      losses: 0,
      game_wins: 0,
      game_losses: 0,
      diff: 0,
      opponents: [],
      beaten: [],
    });
  }
  for (const match of matches) {
    const one = stats.get(match.teamOneId);
    const two = stats.get(match.teamTwoId);
    if (!one || !two) continue;
    one.opponents.push(match.teamTwoId);
    two.opponents.push(match.teamOneId);
    if (match.scoreOne > match.scoreTwo) {
      one.wins += 1;
      two.losses += 1;
      one.beaten.push(match.teamTwoId);
    } else if (match.scoreTwo > match.scoreOne) {
      two.wins += 1;
      one.losses += 1;
      two.beaten.push(match.teamOneId);
    }
    one.game_wins += match.scoreOne;
    one.game_losses += match.scoreTwo;
    one.diff += match.scoreOne - match.scoreTwo;
    two.game_wins += match.scoreTwo;
    two.game_losses += match.scoreOne;
    two.diff += match.scoreTwo - match.scoreOne;
  }
  return [...stats.values()].sort(
    (a, b) => b.wins - a.wins || b.diff - a.diff || a.team_id - b.team_id,
  );
}

/** 瑞士轮进行状态：按「3 胜晋级、3 负淘汰」判定各队伍的进度。 */
async function swissProgress(seasonId: number) {
  const standings = await swissStandings(seasonId);
  const bySeed = (a: SwissStanding, b: SwissStanding) =>
    b.wins - a.wins || a.losses - b.losses || b.diff - a.diff || a.team_id - b.team_id;
  return {
    // 晋级顺序即淘汰赛种子顺序：3-0 优于 3-1 优于 3-2，再比小局净胜。
    qualified: standings
      .filter((row) => row.wins >= 3)
      .sort(bySeed)
      .map((row) => row.team_id),
    eliminated: standings.filter((row) => row.losses >= 3).map((row) => row.team_id),
    active: standings.filter((row) => row.wins < 3 && row.losses < 3).map((row) => row.team_id),
  };
}

function shuffleIds(ids: number[]): number[] {
  const result = [...ids];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 在给定队伍集合里搜索一组「完全不重赛」的配对；无解返回 null。
 *
 * 规模只有 8 队以内（最多 7!! = 105 种两两组合），直接回溯即可，
 * 比贪心匹配更可靠：贪心先配错一对就会被迫安排重赛。
 */
function pairWithoutRematch(
  pool: number[],
  played: (a: number, b: number) => boolean,
): [number, number][] | null {
  if (pool.length === 0) return [];
  if (pool.length % 2 === 1) return null;
  const [first, ...rest] = pool;
  for (let i = 0; i < rest.length; i += 1) {
    if (played(first, rest[i])) continue;
    const remaining = rest.filter((_, index) => index !== i);
    const tail = pairWithoutRematch(remaining, played);
    if (tail) return [[first, rest[i]], ...tail];
  }
  return null;
}

/**
 * 按胜场分组排出「完全不重赛」的对阵；无解返回 null。
 *
 * - 组内队伍数为奇数（或偶数但组不出合法对阵）时，让组内末位选手下沉到下一档；
 *   会依次尝试不同的下沉人选，直到上下两档都能排出不重赛的对阵。
 */
function pairGroupsWithoutRematch(
  groups: number[][],
  played: (a: number, b: number) => boolean,
): [number, number][] | null {
  const pairs: [number, number][] = [];
  let floaters: number[] = [];

  for (const groupIds of groups) {
    const pool = [...floaters, ...groupIds];
    if (!pool.length) continue;

    // 优先尝试整组直接配对（含上一档下沉下来的队伍）。
    if (pool.length % 2 === 0) {
      const matched = pairWithoutRematch(pool, played);
      if (matched) {
        pairs.push(...matched);
        floaters = [];
        continue;
      }
    }

    // 否则让组内末位（种子靠后）下沉，挑一个能让本档剩余也能配平的人选。
    let floated: number | null = null;
    for (let i = groupIds.length - 1; i >= 0; i -= 1) {
      const candidate = groupIds[i];
      const rest = [...floaters, ...groupIds.filter((id) => id !== candidate)];
      if (rest.length % 2 !== 0) continue;
      const matched = pairWithoutRematch(rest, played);
      if (!matched) continue;
      pairs.push(...matched);
      floated = candidate;
      break;
    }
    if (floated === null) return null;
    floaters = [floated];
  }

  return floaters.length ? null : pairs;
}

/** 重赛的代价，远大于任何战绩差，保证「重赛最少」是首要目标。 */
const REMATCH_COST = 1000;

/**
 * 允许重赛时的兜底配对：回溯枚举所有两两组合，取「重赛场次最少」的方案；
 * 重赛数相同时再尽量让同战绩的队伍互打（战绩档位差之和最小）。
 */
function pairWithFewestRematch(
  pool: number[],
  groupIndex: Map<number, number>,
  played: (a: number, b: number) => boolean,
): [number, number][] {
  let best: [number, number][] = [];
  let bestCost = Number.POSITIVE_INFINITY;
  const pairs: [number, number][] = [];

  const search = (remaining: number[], cost: number) => {
    if (cost >= bestCost) return;
    if (!remaining.length) {
      best = [...pairs];
      bestCost = cost;
      return;
    }
    const [first, ...rest] = remaining;
    for (let i = 0; i < rest.length; i += 1) {
      const gap = Math.abs((groupIndex.get(first) ?? 0) - (groupIndex.get(rest[i]) ?? 0));
      pairs.push([first, rest[i]]);
      search(
        rest.filter((_, index) => index !== i),
        cost + (played(first, rest[i]) ? REMATCH_COST : 0) + gap,
      );
      pairs.pop();
    }
  };
  search([...pool], 0);
  return best;
}

/**
 * 按胜场分组配对：同分互打，优先避免重赛。
 *
 * 先尝试严格「不重赛」的方案；若当前战绩下已不存在这样的方案
 * （例如只剩两支待定队伍且此前已经交手过），退化为「重赛最少」的方案继续排，
 * 而不是直接报错。待定队伍数为奇数时仍然无法配对。
 */
function pairSwissGroups(
  groups: number[][],
  played: (a: number, b: number) => boolean,
): [number, number][] {
  const strict = pairGroupsWithoutRematch(groups, played);
  if (strict) return strict;

  const pool = groups.flat();
  if (pool.length % 2 !== 0) {
    throw new ApiError(409, '瑞士轮待定队伍数为奇数，无法完成配对');
  }
  const groupIndex = new Map<number, number>();
  groups.forEach((ids, index) => ids.forEach((id) => groupIndex.set(id, index)));
  return pairWithFewestRematch(pool, groupIndex, played);
}

/** 生成某一轮瑞士轮对阵：全部 BO3；第 1 轮随机，之后只让待定队伍按战绩分组互打。 */
async function swissRoundPairing(
  seasonId: number,
  teamIds: number[],
  round: number,
): Promise<{ teamOneId: number; teamTwoId: number; bo: 'BO1' | 'BO3' }[]> {
  const matches = await prisma.teamSeasonMatch.findMany({
    where: { seasonId, phase: 'SWISS' },
  });
  const played = new Map<number, Set<number>>(teamIds.map((id) => [id, new Set<number>()]));
  for (const match of matches) {
    played.get(match.teamOneId)?.add(match.teamTwoId);
    played.get(match.teamTwoId)?.add(match.teamOneId);
  }
  const hasPlayed = (a: number, b: number) => played.get(a)?.has(b) ?? false;

  if (round === 1) {
    const shuffled = shuffleIds(teamIds);
    const pairs: [number, number][] = [];
    for (let i = 0; i + 1 < shuffled.length; i += 2) pairs.push([shuffled[i], shuffled[i + 1]]);
    return pairs.map(([a, b]) => ({ teamOneId: a, teamTwoId: b, bo: 'BO3' as const }));
  }

  // 之后各轮：已晋级（3 胜）与已淘汰（3 负）的队伍不再配对。
  const { active } = await swissProgress(seasonId);
  const record = new Map<number, number>();
  for (const row of await swissStandings(seasonId)) record.set(row.team_id, row.wins);
  const groups = new Map<number, number[]>();
  for (const id of active) {
    const wins = record.get(id) ?? 0;
    groups.set(wins, [...(groups.get(wins) ?? []), id]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, ids]) => ids);
  return pairSwissGroups(ordered, hasPlayed).map(([a, b]) => ({
    teamOneId: a,
    teamTwoId: b,
    bo: 'BO3' as const,
  }));
}

/** 已报名瑞士轮的 8 支队伍：取出现在任意瑞士轮比赛中的队伍 id。 */
function swissParticipantIds(matches: { teamOneId: number; teamTwoId: number }[]) {
  return [...new Set(matches.flatMap((match) => [match.teamOneId, match.teamTwoId]))];
}

/** 涅槃组四强 BO5：积分前 4 打两场半决赛（1v4、2v3），胜者晋级登峰组瑞士轮。 */
export async function startNirvanaPlayoffs(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    include: { teams: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  });
  if (!season) throw notFound('战队赛不存在');
  if (season.status !== 'POINTS') throw badRequest('当前状态不能生成涅槃组四强');
  const pending = await prisma.teamSeasonMatch.count({
    where: { seasonId, phase: 'POINTS', status: { not: 'FINISHED' } },
  });
  if (pending > 0) throw badRequest('还有涅槃组选拔赛未录入战果');

  const nirvana = (await seasonStandings(seasonId))
    .filter((row) => row.division === 'NIRVANA')
    .slice(0, 4)
    .map((row) => row.team_id);
  if (nirvana.length < 4) throw badRequest('涅槃组至少需要 4 支战队才能进行四强赛');

  const firstDay = season.startDate ?? new Date();
  // 与五轮单循环衔接：第 6 天晚上 20:00 两场 BO5 同时开。
  const kickoff = atTimeOfDay(firstSaturdayOfWeek(firstDay), 5, 20, 0);
  const [first, second, third, fourth] = nirvana;

  await prisma.$transaction([
    prisma.teamSeasonMatch.deleteMany({
      where: { seasonId, phase: 'PLAYOFF', stage: 'NIRVANA_SEMIFINAL' },
    }),
    prisma.teamSeasonMatch.createMany({
      data: [
        {
          seasonId,
          phase: 'PLAYOFF' as const,
          stage: 'NIRVANA_SEMIFINAL' as const,
          dayOfWeek: (6 + 5) % 7,
          roundNo: 1,
          scheduleOrder: 0,
          bo: 'BO5',
          scheduledAt: kickoff,
          teamOneId: first,
          teamTwoId: fourth,
        },
        {
          seasonId,
          phase: 'PLAYOFF' as const,
          stage: 'NIRVANA_SEMIFINAL' as const,
          dayOfWeek: (6 + 5) % 7,
          roundNo: 1,
          scheduleOrder: 1,
          bo: 'BO5',
          scheduledAt: kickoff,
          teamOneId: second,
          teamTwoId: third,
        },
      ],
    }),
    prisma.teamSeason.update({ where: { id: seasonId }, data: { status: 'PLAYOFFS' } }),
  ]);
  return { msg: '涅槃组四强对阵已生成', count: 2 };
}

/** 核心管理员：调整涅槃组四强两场半决赛的对阵配对（录入战果前可改）。 */
export async function updateNirvanaSemifinalPairing(
  seasonId: number,
  pairs: { matchId: number; teamOneId: number; teamTwoId: number }[],
) {
  if (!Array.isArray(pairs) || pairs.length !== 2)
    throw badRequest('参数无效：需要两场半决赛的配对');

  const matches = await prisma.teamSeasonMatch.findMany({
    where: { seasonId, phase: 'PLAYOFF', stage: 'NIRVANA_SEMIFINAL' },
    orderBy: { scheduleOrder: 'asc' },
  });
  if (matches.length !== 2) throw badRequest('涅槃组四强对阵尚未生成');
  const matchIdSet = new Set(matches.map((match) => match.id));
  if (!pairs.every((pair) => matchIdSet.has(pair.matchId)))
    throw badRequest('配对中的场次不属于涅槃组四强');
  if (matches.some((match) => match.status !== 'CREATED'))
    throw badRequest('已录入战果或已结束的场次不能调整对阵，请先重置该场次');

  const currentIds = matches.flatMap((match) => [match.teamOneId, match.teamTwoId]);
  const nextIds = pairs.flatMap((pair) => [pair.teamOneId, pair.teamTwoId]);
  if (new Set(nextIds).size !== 4) throw badRequest('四支战队不能重复');
  const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
  if (JSON.stringify(sorted(currentIds)) !== JSON.stringify(sorted(nextIds)))
    throw badRequest('所选战队与当前四强名单不一致');

  await prisma.$transaction(
    pairs.map((pair) =>
      prisma.teamSeasonMatch.update({
        where: { id: pair.matchId },
        data: { teamOneId: pair.teamOneId, teamTwoId: pair.teamTwoId },
      }),
    ),
  );
  return { msg: '涅槃组四强对阵已调整' };
}

/** 第 2 周周六开启瑞士轮：登峰组全部 + 涅槃组四强胜者共 8 队，随机抽签打第 1 轮 BO3。 */
export async function startSwiss(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    include: { teams: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  });
  if (!season) throw notFound('战队赛不存在');
  if (season.status !== 'PLAYOFFS') throw badRequest('当前状态不能开始瑞士轮');

  const nirvanaSemis = await prisma.teamSeasonMatch.findMany({
    where: { seasonId, phase: 'PLAYOFF', stage: 'NIRVANA_SEMIFINAL' },
    orderBy: { id: 'asc' },
  });
  if (nirvanaSemis.length < 2) throw badRequest('涅槃组四强对阵尚未生成');
  if (nirvanaSemis.some((match) => match.status !== 'FINISHED')) {
    throw badRequest('还有涅槃组四强赛未录入战果');
  }
  const nirvanaWinners = nirvanaSemis.map((match) =>
    match.scoreOne > match.scoreTwo ? match.teamOneId : match.teamTwoId,
  );
  const apex = season.teams.filter((team) => team.division === 'APEX').map((team) => team.id);
  if (apex.length + nirvanaWinners.length !== 8) {
    throw badRequest('瑞士轮需要 8 支战队（登峰组 6 队 + 涅槃组四强 2 名胜者）');
  }

  // 清空旧瑞士轮（幂等重开），保留涅槃组四强记录供名次展示。
  await prisma.teamSeasonMatch.deleteMany({ where: { seasonId, phase: 'SWISS' } });
  const participants = [...apex, ...nirvanaWinners];
  const pairing = await swissRoundPairing(seasonId, participants, 1);
  const firstDay = season.startDate ?? new Date();
  await prisma.$transaction([
    prisma.teamSeasonMatch.createMany({
      data: pairing.map((pair, index) => ({
        seasonId,
        phase: 'SWISS' as const,
        roundNo: 1,
        scheduleOrder: index,
        bo: pair.bo,
        dayOfWeek: 6,
        scheduledAt: slotTime(SEASON_SLOTS.week2Saturday, firstDay),
        teamOneId: pair.teamOneId,
        teamTwoId: pair.teamTwoId,
      })),
    }),
    prisma.teamSeason.update({ where: { id: seasonId }, data: { status: 'SWISS' } }),
  ]);
  return { msg: '瑞士轮第 1 轮对阵已生成', count: pairing.length };
}

/** 推进瑞士轮下一轮：全部 BO3，赢 3 场晋级、输 3 场淘汰，直到产生 4 支晋级队伍。 */
export async function advanceSwiss(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw notFound('战队赛不存在');
  if (season.status !== 'SWISS') throw badRequest('当前状态不能推进瑞士轮');
  const matches = await prisma.teamSeasonMatch.findMany({
    where: { seasonId, phase: 'SWISS' },
    orderBy: { roundNo: 'asc' },
  });
  if (!matches.length) throw badRequest('瑞士轮尚未开始');
  const currentRound = Math.max(...matches.map((m) => m.roundNo));
  if (matches.some((match) => match.roundNo === currentRound && match.status !== 'FINISHED')) {
    throw badRequest('还有瑞士轮比赛未录入战果');
  }

  const { qualified, active } = await swissProgress(seasonId);
  if (!active.length) {
    if (qualified.length !== 4) {
      throw new ApiError(409, '瑞士轮战绩异常，晋级队伍不足 4 支');
    }
    return { msg: '瑞士轮已打完，4 支晋级队伍已产生', round: currentRound, count: 0, done: true };
  }

  const nextRound = currentRound + 1;
  const participants = swissParticipantIds(matches);
  const pairing = await swissRoundPairing(seasonId, participants, nextRound);
  if (pairing.length * 2 !== active.length) {
    throw new ApiError(409, '瑞士轮配对异常，无法为全部待定队伍生成对阵');
  }
  const pairKey = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const playedPairs = new Set(matches.map((match) => pairKey(match.teamOneId, match.teamTwoId)));
  const rematchCount = pairing.filter((pair) =>
    playedPairs.has(pairKey(pair.teamOneId, pair.teamTwoId)),
  ).length;
  const firstDay = season.startDate ?? new Date();
  const scheduledAt = slotTime(
    nextRound <= 2 ? SEASON_SLOTS.week2Saturday : SEASON_SLOTS.week2Sunday,
    firstDay,
  );
  await prisma.teamSeasonMatch.createMany({
    data: pairing.map((pair, index) => ({
      seasonId,
      phase: 'SWISS' as const,
      roundNo: nextRound,
      scheduleOrder: index,
      bo: pair.bo,
      dayOfWeek: nextRound <= 2 ? 6 : 0,
      scheduledAt,
      teamOneId: pair.teamOneId,
      teamTwoId: pair.teamTwoId,
    })),
  });
  return {
    msg: `瑞士轮第 ${nextRound} 轮已生成（待定 ${active.length} 支 / 已晋级 ${qualified.length} 支${
      rematchCount ? ` / 其中 ${rematchCount} 场为重复对阵` : ''
    }）`,
    round: nextRound,
    count: pairing.length,
  };
}

/**
 * 赛季收尾名次：冠军/亚军/季军/殿军来自淘汰赛；
 * 未进四强的瑞士轮队伍按瑞士轮战绩排 5-8；涅槃组未晋级队伍按选拔积分排末尾。
 */
async function finalRankOrder(seasonId: number, championId: number, runnerupId: number) {
  const thirdMatch = await prisma.teamSeasonMatch.findFirst({
    where: { seasonId, phase: 'PLAYOFF', stage: 'THIRD', status: 'FINISHED' },
  });
  const thirdId = thirdMatch
    ? thirdMatch.scoreOne > thirdMatch.scoreTwo
      ? thirdMatch.teamOneId
      : thirdMatch.teamTwoId
    : null;
  const fourthId = thirdMatch
    ? thirdMatch.scoreOne > thirdMatch.scoreTwo
      ? thirdMatch.teamTwoId
      : thirdMatch.teamOneId
    : null;

  const swiss = await swissStandings(seasonId);
  const qualified = new Set(
    [championId, runnerupId, thirdId, fourthId].filter((id): id is number => id != null),
  );
  const swissEliminated = swiss
    .filter((row) => !qualified.has(row.team_id))
    .map((row) => row.team_id);

  const nirvana = (await seasonStandings(seasonId)).filter((row) => row.division === 'NIRVANA');
  const swissTeamIds = new Set(swiss.map((row) => row.team_id));
  const nirvanaEliminated = nirvana
    .filter((row) => !swissTeamIds.has(row.team_id))
    .map((row) => row.team_id);

  const ranked: number[] = [championId, runnerupId];
  if (thirdId != null) ranked.push(thirdId);
  if (fourthId != null) ranked.push(fourthId);
  ranked.push(...swissEliminated, ...nirvanaEliminated);
  return ranked;
}

/** 录入一场战队赛战果并推进：积分赛只累计；半决赛打完等生成决赛；决赛打完写全部名次并结束赛季。 */
export async function finishSeasonMatch(
  matchId: number,
  scoreOne: number,
  scoreTwo: number,
  actorId?: number,
) {
  const match = await prisma.teamSeasonMatch.findUnique({
    where: { id: matchId },
    include: { season: { select: { id: true, status: true, startDate: true } } },
  });
  if (!match) throw notFound('场次不存在');
  const editingFinishedMatch = match.status === 'FINISHED';
  if (editingFinishedMatch && !(actorId && (await isCoreAdminActor(actorId)))) {
    throw forbidden('本场已结束，只有核心管理员可以修改比分');
  }
  if (
    !Number.isInteger(scoreOne) ||
    !Number.isInteger(scoreTwo) ||
    scoreOne < 0 ||
    scoreTwo < 0 ||
    !isValidBoScore(match.bo, scoreOne, scoreTwo)
  ) {
    throw badRequest(boScoreHint(match.bo));
  }

  if (editingFinishedMatch) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "TeamSeasonMatch" WHERE "id" = ${matchId} FOR UPDATE`;
        await tx.teamSeasonMatch.update({ where: { id: matchId }, data: { scoreOne, scoreTwo } });
        await settleMarketsForSeasonScore(tx, matchId, scoreOne, scoreTwo);
      },
      { timeout: 30000 },
    );

    if (match.phase === 'POINTS') {
      // 涅槃组选拔比分被修改：积分榜随之更新；若赛季已结束则重算最终名次。
      if (match.season.status === 'FINISHED') {
        const finalMatch = await prisma.teamSeasonMatch.findFirst({
          where: { seasonId: match.seasonId, phase: 'PLAYOFF', stage: 'FINAL', status: 'FINISHED' },
        });
        if (finalMatch) {
          const winnerId =
            finalMatch.scoreOne > finalMatch.scoreTwo ? finalMatch.teamOneId : finalMatch.teamTwoId;
          const loserId =
            finalMatch.scoreOne > finalMatch.scoreTwo ? finalMatch.teamTwoId : finalMatch.teamOneId;
          const order = await finalRankOrder(match.seasonId, winnerId, loserId);
          await prisma.$transaction(
            order.map((teamId, index) =>
              prisma.teamSeasonTeam.update({
                where: { id: teamId },
                data: { finalRank: index + 1 },
              }),
            ),
          );
        }
      }
      return { msg: '积分赛比分已修改，积分榜已更新', phase: 'POINTS' as const };
    }

    if (match.stage === 'SEMIFINAL') {
      const [semifinals, finalMatch, thirdMatch] = await Promise.all([
        prisma.teamSeasonMatch.findMany({
          where: { seasonId: match.seasonId, phase: 'PLAYOFF', stage: 'SEMIFINAL' },
          orderBy: { id: 'asc' },
        }),
        prisma.teamSeasonMatch.findFirst({
          where: { seasonId: match.seasonId, phase: 'PLAYOFF', stage: 'FINAL' },
        }),
        prisma.teamSeasonMatch.findFirst({
          where: { seasonId: match.seasonId, phase: 'PLAYOFF', stage: 'THIRD' },
        }),
      ]);

      if (
        finalMatch &&
        semifinals.length >= 2 &&
        semifinals.every((row) => row.status === 'FINISHED')
      ) {
        const [firstSemi, secondSemi] = semifinals;
        const winnerOf = (semi: (typeof semifinals)[number]) =>
          semi.scoreOne > semi.scoreTwo ? semi.teamOneId : semi.teamTwoId;
        const loserOf = (semi: (typeof semifinals)[number]) =>
          semi.scoreOne > semi.scoreTwo ? semi.teamTwoId : semi.teamOneId;
        await prisma.$transaction([
          prisma.teamSeasonMatch.update({
            where: { id: finalMatch.id },
            data: {
              teamOneId: winnerOf(firstSemi),
              teamTwoId: winnerOf(secondSemi),
            },
          }),
          ...(thirdMatch
            ? [
                prisma.teamSeasonMatch.update({
                  where: { id: thirdMatch.id },
                  data: {
                    teamOneId: loserOf(firstSemi),
                    teamTwoId: loserOf(secondSemi),
                  },
                }),
              ]
            : []),
        ]);

        if (finalMatch.status === 'FINISHED') {
          const winnerId =
            finalMatch.scoreOne > finalMatch.scoreTwo ? winnerOf(firstSemi) : winnerOf(secondSemi);
          const loserId =
            finalMatch.scoreOne > finalMatch.scoreTwo ? winnerOf(secondSemi) : winnerOf(firstSemi);
          const order = await finalRankOrder(match.seasonId, winnerId, loserId);
          await prisma.$transaction([
            ...order.map((teamId, index) =>
              prisma.teamSeasonTeam.update({
                where: { id: teamId },
                data: { finalRank: index + 1 },
              }),
            ),
            prisma.teamSeason.update({
              where: { id: match.seasonId },
              data: { status: 'FINISHED' },
            }),
          ]);
          await distributeSeasonPrizes(match.seasonId).catch(() => undefined);
        }
      }
      return { msg: '半决赛比分已修改，相关对阵和名次已更新', phase: 'SEMIFINAL' as const };
    }

    if (match.stage === 'FINAL') {
      const winnerId = scoreOne > scoreTwo ? match.teamOneId : match.teamTwoId;
      const loserId = scoreOne > scoreTwo ? match.teamTwoId : match.teamOneId;
      const order = await finalRankOrder(match.seasonId, winnerId, loserId);
      await prisma.$transaction([
        ...order.map((teamId, index) =>
          prisma.teamSeasonTeam.update({
            where: { id: teamId },
            data: { finalRank: index + 1 },
          }),
        ),
        prisma.teamSeason.update({
          where: { id: match.seasonId },
          data: { status: 'FINISHED' },
        }),
      ]);
      await distributeSeasonPrizes(match.seasonId).catch(() => undefined);
      return { msg: '决赛比分已修改，最终名次已更新', phase: 'FINAL' as const };
    }

    return { msg: '战果已修改', phase: match.phase };
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TeamSeasonMatch" WHERE "id" = ${matchId} FOR UPDATE`;
      await tx.teamSeasonMatch.update({
        where: { id: matchId },
        data: { scoreOne, scoreTwo, status: 'FINISHED' },
      });
      await settleMarketsForSeasonScore(tx, matchId, scoreOne, scoreTwo);
    },
    { timeout: 30000 },
  );

  if (match.phase === 'POINTS') {
    return { msg: '战果已录入', phase: 'POINTS' as const };
  }

  if (match.phase === 'SWISS') {
    const { qualified, eliminated, active } = await swissProgress(match.seasonId);
    return {
      msg:
        active.length === 0 && qualified.length === 4
          ? '瑞士轮战果已录入，4 支晋级队伍已产生，可进入半决赛'
          : `瑞士轮战果已录入（晋级 ${qualified.length} / 淘汰 ${eliminated.length} / 待定 ${active.length}）`,
      phase: 'SWISS' as const,
      qualified: qualified.length,
      eliminated: eliminated.length,
      active: active.length,
      done: active.length === 0 && qualified.length === 4,
    };
  }

  const winnerId = scoreOne > scoreTwo ? match.teamOneId : match.teamTwoId;
  const loserId = scoreOne > scoreTwo ? match.teamTwoId : match.teamOneId;

  // 半决赛：只推进状态，决赛/季军赛对阵等两场都录完再生成。
  if (match.stage === 'SEMIFINAL') {
    const pending = await prisma.teamSeasonMatch.count({
      where: {
        seasonId: match.seasonId,
        phase: 'PLAYOFF',
        stage: 'SEMIFINAL',
        status: { not: 'FINISHED' },
      },
    });
    return {
      msg:
        pending > 0
          ? `半决赛战果已录入，还有 ${pending} 场半决赛未录入`
          : '半决赛已全部打完，可以生成决赛与季军赛对阵',
      phase: 'SEMIFINAL' as const,
      final_ready: pending === 0,
    };
  }

  // 涅槃组四强：只推进状态，两场都打完即可生成瑞士轮。
  if (match.stage === 'NIRVANA_SEMIFINAL') {
    const pending = await prisma.teamSeasonMatch.count({
      where: {
        seasonId: match.seasonId,
        phase: 'PLAYOFF',
        stage: 'NIRVANA_SEMIFINAL',
        status: { not: 'FINISHED' },
      },
    });
    return {
      msg:
        pending > 0
          ? `涅槃组四强战果已录入，还有 ${pending} 场未录入`
          : '涅槃组四强已全部打完，可以开始瑞士轮',
      phase: 'PLAYOFF' as const,
      swiss_ready: pending === 0,
    };
  }

  // 季军赛：只记录，不影响赛季结束（等决赛打完一并收尾）。
  if (match.stage === 'THIRD') {
    return { msg: '季军赛战果已录入', phase: 'PLAYOFF' as const };
  }

  // 决赛：写全部名次（冠军/亚军/季军/殿军 + 瑞士轮与涅槃组名次），赛季结束。
  const order = await finalRankOrder(match.seasonId, winnerId, loserId);
  await prisma.$transaction([
    ...order.map((teamId, index) =>
      prisma.teamSeasonTeam.update({ where: { id: teamId }, data: { finalRank: index + 1 } }),
    ),
    prisma.teamSeason.update({
      where: { id: match.seasonId },
      data: { status: 'FINISHED' },
    }),
  ]);
  await distributeSeasonPrizes(match.seasonId).catch(() => undefined);
  return {
    msg: '决赛已打完，周冠军诞生！',
    phase: 'FINAL' as const,
    champion_team_id: winnerId,
  };
}

/** 核心管理员：把一场战队赛重置到开赛前（清比分、清战绩、恢复 CREATED）。 */
export async function resetSeasonMatch(matchId: number) {
  const match = await prisma.teamSeasonMatch.findUnique({
    where: { id: matchId },
    include: { season: { select: { status: true } } },
  });
  if (!match) throw notFound('场次不存在');
  if (match.season.status === 'FINISHED') {
    throw badRequest('赛季已结束，不能重置单场；请先将赛季状态调回再操作');
  }
  await prisma.$transaction([
    prisma.matchGameRecord.deleteMany({ where: { seasonMatchId: matchId } }),
    prisma.teamSeasonMatch.update({
      where: { id: matchId },
      data: { scoreOne: 0, scoreTwo: 0, status: 'CREATED', recordsConfirmed: false },
    }),
  ]);
  return { msg: '场次已重置到开赛前' };
}

/**
 * 瑞士轮 3 轮全部打完 → 按四强顺位生成两场 BO5 半决赛（第 3 周周六）：
 * 1 号种子 vs 4 号种子、2 号种子 vs 3 号种子。
 */
export async function startPlayoffs(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    include: { teams: true },
  });
  if (!season) throw notFound('战队赛不存在');
  if (season.status !== 'SWISS') throw badRequest('当前状态不能进入淘汰赛');
  const swiss = await prisma.teamSeasonMatch.findMany({
    where: { seasonId, phase: 'SWISS' },
  });
  if (!swiss.length) throw badRequest('瑞士轮尚未开始');
  if (swiss.some((match) => match.status !== 'FINISHED')) {
    throw badRequest('还有瑞士轮比赛未录入战果');
  }

  const { qualified, active } = await swissProgress(seasonId);
  if (active.length > 0) throw badRequest('还有队伍未打完瑞士轮（3 胜晋级 / 3 负淘汰）');
  if (qualified.length !== 4) {
    throw new ApiError(409, '瑞士轮晋级队伍不足 4 支');
  }

  const [first, second, third, fourth] = qualified;
  const kickoff = slotTime(SEASON_SLOTS.week3Saturday, season.startDate ?? new Date());

  await prisma.$transaction([
    prisma.teamSeasonMatch.deleteMany({ where: { seasonId, phase: 'PLAYOFF' } }),
    prisma.teamSeasonMatch.createMany({
      data: [
        {
          seasonId,
          phase: 'PLAYOFF' as const,
          stage: 'SEMIFINAL' as const,
          dayOfWeek: 6,
          roundNo: 1,
          scheduleOrder: 0,
          bo: 'BO5',
          scheduledAt: kickoff,
          teamOneId: first,
          teamTwoId: fourth,
        },
        {
          seasonId,
          phase: 'PLAYOFF' as const,
          stage: 'SEMIFINAL' as const,
          dayOfWeek: 6,
          roundNo: 2,
          scheduleOrder: 1,
          bo: 'BO5',
          scheduledAt: kickoff,
          teamOneId: second,
          teamTwoId: third,
        },
      ],
    }),
    prisma.teamSeason.update({ where: { id: seasonId }, data: { status: 'PLAYOFFS' } }),
  ]);
  return { msg: '已进入淘汰赛，两场半决赛对阵已生成' };
}

/** 两场半决赛都打完 → 生成第 3 周周日的 BO5 决赛与季军赛。 */
export async function startFinal(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw notFound('战队赛不存在');
  if (season.status !== 'PLAYOFFS') throw badRequest('当前状态不能生成决赛');

  const semis = await prisma.teamSeasonMatch.findMany({
    where: { seasonId, phase: 'PLAYOFF', stage: 'SEMIFINAL' },
    orderBy: [{ id: 'asc' }],
  });
  if (semis.length < 2) throw badRequest('半决赛对阵不完整');
  if (semis.some((match) => match.status !== 'FINISHED')) throw badRequest('还有半决赛未录入战果');

  const winnerOf = (match: (typeof semis)[number]) =>
    match.scoreOne > match.scoreTwo ? match.teamOneId : match.teamTwoId;
  const loserOf = (match: (typeof semis)[number]) =>
    match.scoreOne > match.scoreTwo ? match.teamTwoId : match.teamOneId;
  const kickoff = slotTime(SEASON_SLOTS.week3Sunday, season.startDate ?? new Date());

  await prisma.$transaction([
    prisma.teamSeasonMatch.deleteMany({
      where: { seasonId, phase: 'PLAYOFF', stage: { in: ['FINAL', 'THIRD'] } },
    }),
    prisma.teamSeasonMatch.create({
      data: {
        seasonId,
        phase: 'PLAYOFF' as const,
        stage: 'FINAL' as const,
        dayOfWeek: 0,
        roundNo: 1,
        scheduleOrder: 0,
        bo: 'BO5',
        scheduledAt: kickoff,
        teamOneId: winnerOf(semis[0]),
        teamTwoId: winnerOf(semis[1]),
      },
    }),
    prisma.teamSeasonMatch.create({
      data: {
        seasonId,
        phase: 'PLAYOFF' as const,
        stage: 'THIRD' as const,
        dayOfWeek: 0,
        roundNo: 1,
        scheduleOrder: 1,
        bo: 'BO5',
        scheduledAt: kickoff,
        teamOneId: loserOf(semis[0]),
        teamTwoId: loserOf(semis[1]),
      },
    }),
  ]);
  return { msg: '决赛与季军赛对阵已生成' };
}

/** 公开视图：某个战队赛的赛程 + 积分榜。 */
export async function getSeasonView(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({ where: { id: seasonId } });
  if (!season) return { season: null, standings: [], swiss_standings: [], matches: [] };
  const [standings, swiss, matches, teams] = await Promise.all([
    seasonStandings(season.id),
    swissStandings(season.id),
    prisma.teamSeasonMatch.findMany({
      where: { seasonId: season.id },
      orderBy: [
        { scheduledAt: 'asc' },
        { scheduleOrder: 'asc' },
        { roundNo: 'asc' },
        { id: 'asc' },
      ],
    }),
    prisma.teamSeasonTeam.findMany({ where: { seasonId: season.id } }),
  ]);
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const briefTeam = (teamId: number) => {
    const team = teamById.get(teamId);
    return team ? { id: team.id, name: team.name, abbr: team.abbr, logo: team.logo } : null;
  };
  const champion = teams.find((team) => team.finalRank === 1);
  return {
    season: {
      id: season.id,
      name: season.name,
      status: season.status,
      start_date: season.startDate?.toISOString() ?? null,
    },
    champion: champion
      ? { id: champion.id, name: champion.name, abbr: champion.abbr, logo: champion.logo }
      : null,
    standings,
    swiss_standings: swiss,
    matches: matches.map((match) => ({
      id: match.id,
      phase: match.phase,
      day_of_week: match.dayOfWeek,
      round_no: match.roundNo,
      bo: match.bo,
      stage: match.stage,
      status: match.status,
      scheduled_at: match.scheduledAt.toISOString(),
      team_one_id: match.teamOneId,
      team_two_id: match.teamTwoId,
      team_one: briefTeam(match.teamOneId),
      team_two: briefTeam(match.teamTwoId),
      score_one: match.scoreOne,
      score_two: match.scoreTwo,
    })),
  };
}

/** 公开视图：某一场战队赛的赛果 + 两队阵容 + 逐局战绩（复用常规赛 result 页结构）。 */
export async function getSeasonMatchResultData(seasonMatchId: number) {
  const match = await prisma.teamSeasonMatch.findUnique({
    where: { id: seasonMatchId },
    include: {
      season: { select: { id: true, name: true, status: true, startDate: true } },
      substitutions: {
        select: {
          teamId: true,
          starterUserId: true,
          substituteUserId: true,
          position: true,
        },
      },
    },
  });
  if (!match) return null;

  const teams = await prisma.teamSeasonTeam.findMany({
    where: { id: { in: [match.teamOneId, match.teamTwoId] } },
    include: {
      members: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { user: { include: { profile: true } } },
      },
    },
  });
  const records = await prisma.matchGameRecord.findMany({
    where: { seasonMatchId },
    orderBy: [{ gameNo: 'asc' }, { id: 'asc' }],
  });

  const teamById = new Map(teams.map((team) => [team.id, team]));
  const userTeam = new Map<number, number>();
  const playerByUser = new Map<
    number,
    { username: string; gameName: string; avatar: string; rank: string }
  >();
  for (const team of teams) {
    for (const member of team.members) {
      userTeam.set(member.userId, team.id);
      playerByUser.set(member.userId, {
        username: member.user.username,
        gameName: member.user.profile?.gameName ?? '',
        avatar: member.user.profile?.avatar ?? '',
        rank: member.user.profile?.rank ?? '',
      });
    }
  }
  // 战队赛对战表（阵容）也带出当前生效称号。
  const lineupTitleMap = await activeTitleMap([...playerByUser.keys()]);

  const briefTeam = (teamId: number) => {
    const team = teamById.get(teamId);
    if (!team) return null;
    const substitutions = match.substitutions.filter((row) => row.teamId === teamId);
    const replacedStarters = new Set(substitutions.map((row) => row.starterUserId));
    const subsByUser = new Map(substitutions.map((row) => [row.substituteUserId, row.position]));
    return {
      id: team.id,
      name: team.name,
      abbr: team.abbr,
      logo: team.logo,
      members: team.members.map((member) => {
        const isReplacedStarter = replacedStarters.has(member.userId);
        const isSubstitute = subsByUser.has(member.userId);
        return {
          user_id: member.userId,
          role: isReplacedStarter ? 'SUB' : isSubstitute ? 'STARTER' : member.role,
          position: isSubstitute ? subsByUser.get(member.userId)! : member.position,
          is_substitute: isSubstitute,
          username: member.user.username,
          game_name: member.user.profile?.gameName ?? '',
          rank: member.user.profile?.rank ?? '',
          avatar: member.user.profile?.avatar ?? '',
          title: lineupTitleMap.get(member.userId) ?? '',
        };
      }),
    };
  };

  const gamesMap = new Map<number, typeof records>();
  for (const record of records) {
    const bucket = gamesMap.get(record.gameNo) ?? [];
    bucket.push(record);
    gamesMap.set(record.gameNo, bucket);
  }

  return {
    season: {
      id: match.season.id,
      name: match.season.name,
      status: match.season.status,
      start_date: match.season.startDate?.toISOString() ?? null,
    },
    match: {
      id: match.id,
      phase: match.phase,
      round_no: match.roundNo,
      stage: match.stage,
      bo: match.bo,
      status: match.status,
      scheduled_at: match.scheduledAt.toISOString(),
      score_one: match.scoreOne,
      score_two: match.scoreTwo,
    },
    team_one: briefTeam(match.teamOneId),
    team_two: briefTeam(match.teamTwoId),
    games: [...gamesMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([gameNo, rows]) => ({
        game_no: gameNo,
        rows: rows.map((record) => {
          const player = playerByUser.get(record.userId);
          const teamId = userTeam.get(record.userId) ?? null;
          return {
            id: record.id,
            user_id: record.userId,
            username: player?.username ?? '',
            display_name: player?.gameName || player?.username || '',
            avatar: player?.avatar ?? '',
            rank: player?.rank ?? '',
            champion: record.champion,
            result: record.result,
            kills: record.kills,
            deaths: record.deaths,
            assists: record.assists,
            is_mvp: record.isMvp,
            is_svp: record.isSvp,
            team_rank: record.teamRank,
            team_pos: record.teamPosition || '无',
            team_id: teamId,
            team_name: teamId ? (teamById.get(teamId)?.name ?? '') : '',
            level: record.level,
            cs: record.cs,
            gold: record.gold,
            vision: record.vision,
            damage_to_champions: record.damageToChampions,
            items: record.items ? record.items.split(',').filter(Boolean) : [],
          };
        }),
      })),
  };
}

/** 公开视图：最近一个战队赛（用于比赛页战队赛 tab）。 */
export async function getCurrentSeasonView() {
  const season = await prisma.teamSeason.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!season) return { season: null, standings: [], matches: [] };
  return getSeasonView(season.id);
}

/** 历届已结束战队赛的冠军战队（供首页开屏动画展示 logo 与成员）。 */
export async function getChampionSplash() {
  const seasons = await prisma.teamSeason.findMany({
    where: { status: 'FINISHED' },
    orderBy: { createdAt: 'desc' },
    include: {
      teams: {
        include: {
          members: {
            orderBy: [{ role: 'asc' }, { id: 'asc' }],
            include: { user: { include: { profile: true } } },
          },
        },
      },
    },
  });
  return seasons.flatMap((season) => {
    const champion = season.teams.find((team) => team.finalRank === 1);
    if (!champion) return [];
    return [
      {
        season_id: season.id,
        season_name: season.name,
        team_name: champion.name,
        team_abbr: champion.abbr,
        team_logo: champion.logo,
        members: champion.members.map((member) => ({
          game_name: member.user.profile?.gameName ?? member.user.username,
          username: member.user.username,
          rank: member.user.profile?.rank ?? '',
          avatar: member.user.profile?.avatar ?? '',
          position: member.position,
          role: member.role,
        })),
      },
    ];
  });
}

/** 战队赛列表（供比赛页历史/我的比赛与常规赛合并展示）。 */
export async function listSeasonsView(userId?: number) {
  const seasons = await prisma.teamSeason.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      teams: { select: { id: true, name: true, abbr: true, logo: true, finalRank: true } },
      _count: { select: { teams: true, matches: true } },
    },
  });
  let memberSeasonIds = new Set<number>();
  if (userId) {
    const memberships = await prisma.teamSeasonMember.findMany({
      where: { userId },
      select: { team: { select: { seasonId: true } } },
    });
    memberSeasonIds = new Set(memberships.map((membership) => membership.team.seasonId));
  }
  return {
    seasons: seasons.map((season) => {
      const champion = season.teams.find((team) => team.finalRank === 1);
      return {
        id: season.id,
        name: season.name,
        status: season.status,
        start_date: season.startDate?.toISOString() ?? null,
        created_at: season.createdAt.toISOString(),
        team_count: season._count.teams,
        match_count: season._count.matches,
        champion_name: champion?.name ?? '',
        champion_abbr: champion?.abbr ?? '',
        champion_logo: champion?.logo ?? '',
        is_member: memberSeasonIds.has(season.id),
      };
    }),
  };
}

/** 个人页「战队经历」：该选手参加过的战队赛（战队 + 最终名次 + 角色）。 */
export async function listUserTeamHistory(userId: number) {
  const memberships = await prisma.teamSeasonMember.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      team: {
        include: {
          season: { select: { id: true, name: true, status: true, startDate: true } },
        },
      },
    },
  });
  return memberships.map((membership) => ({
    season_id: membership.team.season.id,
    season_name: membership.team.season.name,
    season_status: membership.team.season.status,
    start_date: membership.team.season.startDate?.toISOString() ?? null,
    team_id: membership.team.id,
    team_name: membership.team.name,
    team_abbr: membership.team.abbr,
    team_logo: membership.team.logo,
    final_rank: membership.team.finalRank,
    role: membership.role,
    position: membership.position,
  }));
}

/* ------------------------------- 报名与邀请 ------------------------------- */

const roleLabel = (role: string) =>
  role === 'CAPTAIN' ? '队长' : role === 'SUB' ? '替补' : '首发';

/** 战队赛报名/取消报名（公开接口，仅登录选手；报名阶段不限人数、无候补）。 */
export async function seasonSignup(request: NextRequest, id: string, action: 'signup' | 'cancel') {
  const seasonId = Number(id);
  if (!Number.isInteger(seasonId) || seasonId < 1)
    return NextResponse.json({ error: '战队赛不存在' }, { status: 404 });
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });

  if (action === 'cancel') {
    const membership = await prisma.teamSeasonMember.findFirst({
      where: { userId: user.id, team: { seasonId } },
      include: {
        team: {
          include: { members: { where: { role: 'CAPTAIN' }, select: { userId: true } } },
        },
      },
    });

    // 队长取消报名 → 解散战队：级联移除队员与邀请，队员回到报名池等待再次邀请。
    if (membership?.role === 'CAPTAIN') {
      await prisma.$transaction([
        prisma.teamSeasonTeam.delete({ where: { id: membership.teamId } }),
        prisma.teamSeasonSignup.deleteMany({ where: { seasonId, userId: user.id } }),
      ]);
      return NextResponse.json({ ok: true, message: '已取消报名，战队已解散' });
    }

    // 普通队员取消报名 → 移出队伍，并通知队长「某队员离开队伍」。
    if (membership) {
      // members 已按 role=CAPTAIN 过滤，取第一个即队长。
      const captainId = membership.team.members[0]?.userId ?? null;
      await prisma.$transaction([
        prisma.teamSeasonMember.delete({ where: { id: membership.id } }),
        prisma.teamSeasonSignup.deleteMany({ where: { seasonId, userId: user.id } }),
        ...(captainId
          ? [
              prisma.teamNotice.create({
                data: {
                  userId: captainId,
                  seasonId,
                  teamId: membership.teamId,
                  type: 'MEMBER_LEFT',
                  refUserId: user.id,
                },
              }),
            ]
          : []),
      ]);
      return NextResponse.json({ ok: true, message: '已取消报名' });
    }

    await prisma.teamSeasonSignup.deleteMany({ where: { seasonId, userId: user.id } });
    return NextResponse.json({ ok: true, message: '已取消报名' });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const main =
    typeof body?.main_pos === 'string'
      ? body.main_pos
      : typeof body?.mainPosition === 'string'
        ? body.mainPosition
        : '';
  if (!SEASON_POSITIONS.has(main))
    return NextResponse.json({ error: '分路不合法' }, { status: 400 });
  const declaration = String(body?.declaration ?? '').trim();
  if (declaration.length > 50)
    return NextResponse.json({ error: '参赛宣言最多 50 字' }, { status: 400 });

  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: { id: true, status: true },
  });
  if (!season) return NextResponse.json({ error: '战队赛不存在' }, { status: 404 });
  if (season.status !== 'DRAFTING')
    return NextResponse.json({ error: '报名已截止' }, { status: 409 });

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      banUntil: true,
      kookName: true,
      profile: { select: { gameName: true, mainPosition: true, rank: true } },
    },
  });
  const banText = banNotice(account?.banUntil);
  if (banText) return NextResponse.json({ error: banText }, { status: 403 });
  const rank = account?.profile?.rank ?? '';
  if (RANKS.indexOf(rank) > RANKS.indexOf('钻石')) {
    return NextResponse.json({ error: '战队赛须达到钻石段位，请加油上分' }, { status: 400 });
  }
  const missing = missingSignupRequirements({
    gameName: account?.profile?.gameName ?? '',
    mainPosition: account?.profile?.mainPosition ?? '',
    rank: account?.profile?.rank ?? '',
    kookName: account?.kookName ?? '',
  });
  if (missing.length)
    return NextResponse.json(
      { error: `报名前请先在「我的资料」补全：${missing.join('、')}`, missing },
      { status: 400 },
    );

  await prisma.teamSeasonSignup.upsert({
    where: { seasonId_userId: { seasonId, userId: user.id } },
    update: { mainPosition: main, declaration },
    create: { seasonId, userId: user.id, mainPosition: main, declaration },
  });
  return NextResponse.json({ ok: true, message: '报名成功' });
}

/**
 * 后台「报名记录」取消战队赛报名（二级管理员及以上）。
 * 与选手自助取消保持一致：队长退赛解散战队，队员退赛移出队伍并通知队长。
 */
export async function cancelSeasonSignup(signupId: number, actorId: number) {
  await assertSecondaryAdmin(actorId, '只有二级管理员及以上可以取消报名');
  const signup = await prisma.teamSeasonSignup.findUnique({
    where: { id: signupId },
    select: {
      id: true,
      seasonId: true,
      userId: true,
      season: { select: { status: true } },
    },
  });
  if (!signup) throw notFound('报名记录不存在');
  if (signup.season.status !== 'DRAFTING') throw badRequest('名单已锁定，不能取消报名');

  const membership = await prisma.teamSeasonMember.findFirst({
    where: { userId: signup.userId, team: { seasonId: signup.seasonId } },
    include: {
      team: {
        include: { members: { where: { role: 'CAPTAIN' }, select: { userId: true } } },
      },
    },
  });

  if (membership?.role === 'CAPTAIN') {
    await prisma.$transaction([
      prisma.teamSeasonTeam.delete({ where: { id: membership.teamId } }),
      prisma.teamSeasonSignup.delete({ where: { id: signup.id } }),
    ]);
    return { msg: '已取消该选手报名，其战队已解散' };
  }

  if (membership) {
    const captainId = membership.team.members[0]?.userId ?? null;
    await prisma.$transaction([
      prisma.teamSeasonMember.delete({ where: { id: membership.id } }),
      prisma.teamSeasonSignup.delete({ where: { id: signup.id } }),
      ...(captainId
        ? [
            prisma.teamNotice.create({
              data: {
                userId: captainId,
                seasonId: signup.seasonId,
                teamId: membership.teamId,
                type: 'MEMBER_LEFT',
                refUserId: signup.userId,
              },
            }),
          ]
        : []),
    ]);
    return { msg: '已取消该选手报名' };
  }

  await prisma.teamSeasonSignup.delete({ where: { id: signup.id } });
  return { msg: '已取消该选手报名' };
}

/**
 * 后台调整战队赛报名分路。
 * - 未入队（含只被邀请过）的选手：只改报名分路。
 * - 已入队的选手：同时调整队伍里的角色（首发 / 替补），每队最多 2 名替补，
 *   替补未满时直接调整角色；替补已满或目标位置被占用时与占用者互换（原替补转首发、顶替其腾出的分路，
 *   分路被占则双方互换分路）。队长固定为队长，只换分路。
 */
export async function changeSeasonSignupPosition(
  signupId: number,
  mainPosition: unknown,
  role: unknown,
) {
  const signup = await prisma.teamSeasonSignup.findUnique({
    where: { id: signupId },
    include: {
      season: {
        select: {
          status: true,
          teams: { select: { id: true, members: true } },
        },
      },
    },
  });
  if (!signup) throw notFound('报名记录不存在');
  if (signup.season.status !== 'DRAFTING') throw badRequest('名单已锁定，不能调整报名位置');
  if (typeof mainPosition !== 'string' || !SEASON_POSITIONS.has(mainPosition))
    throw badRequest('分路不合法');

  const team = signup.season.teams.find((item) =>
    item.members.some((member) => member.userId === signup.userId),
  );
  const member = team?.members.find((item) => item.userId === signup.userId);

  // 尚未入队：只更新报名分路。
  if (!team || !member) {
    await prisma.teamSeasonSignup.update({ where: { id: signupId }, data: { mainPosition } });
    return { msg: '报名位置已更新' };
  }

  const isCaptain = member.role === 'CAPTAIN';
  const nextRole = isCaptain ? 'CAPTAIN' : role === 'SUB' ? 'SUB' : 'STARTER';
  // 需要互换的占用者：改替补时是本队已有的替补，改首发时是该分路上的首发/队长。
  const otherSubs = team.members.filter(
    (item) => item.role === 'SUB' && item.userId !== member.userId,
  );
  const occupant =
    nextRole === 'SUB'
      ? member.role !== 'SUB' && otherSubs.length >= 2
        ? otherSubs[0]
        : undefined
      : team.members.find(
          (item) =>
            item.role !== 'SUB' && item.position === mainPosition && item.userId !== member.userId,
        );
  if (occupant?.role === 'CAPTAIN') throw badRequest('该分路是队长的分路，请选择其他分路');

  const memberUpdates = [
    prisma.teamSeasonMember.update({
      where: { id: member.id },
      data: { role: nextRole, position: mainPosition },
    }),
    prisma.teamSeasonSignup.update({ where: { id: signupId }, data: { mainPosition } }),
  ];
  // 队长不参与角色互换；原本有分路槽的选手（首发/队长）把自己腾出的分路交给对方，
  // 原本是替补的选手没有分路槽可交，对方保留自己的分路。
  if (occupant) {
    memberUpdates.push(
      prisma.teamSeasonMember.update({
        where: { id: occupant.id },
        data: {
          role: isCaptain ? occupant.role : member.role,
          position: member.role === 'SUB' ? occupant.position : member.position,
        },
      }),
    );
  }
  await prisma.$transaction(memberUpdates);

  if (!occupant) return { msg: '报名位置已更新' };
  // 只有确实换过角色才提「角色互换」，纯分路腾挪就只说分路。
  const swappedRole = !isCaptain && occupant.role !== member.role;
  return {
    msg: swappedRole
      ? '报名位置已更新，并与对方互换了角色与分路'
      : '报名位置已更新，并与对方互换了分路',
  };
}

/** 战队赛报名状态（供赛事页报名按钮使用）。 */
export async function seasonSignupState(request: NextRequest, id: string) {
  const seasonId = Number(id);
  const user = await getSessionUser(request);
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: { id: true, status: true },
  });
  const signed = user
    ? await prisma.teamSeasonSignup.findUnique({
        where: { seasonId_userId: { seasonId, userId: user.id } },
      })
    : null;

  let defaultMain = '';
  let banUntil: string | null = null;
  let missingFields: string[] = [];
  if (user) {
    const account = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        banUntil: true,
        kookName: true,
        profile: { select: { gameName: true, mainPosition: true, rank: true } },
      },
    });
    defaultMain = account?.profile?.mainPosition ?? '';
    banUntil = account?.banUntil ? account.banUntil.toISOString() : null;
    missingFields = missingSignupRequirements({
      gameName: account?.profile?.gameName ?? '',
      mainPosition: account?.profile?.mainPosition ?? '',
      rank: account?.profile?.rank ?? '',
      kookName: account?.kookName ?? '',
    });
  }

  return NextResponse.json({
    signable: season?.status === 'DRAFTING',
    loggedIn: Boolean(user),
    signed: signed ? { mainPosition: signed.mainPosition, declaration: signed.declaration } : null,
    isCoreAdmin: user?.isCoreAdmin ?? false,
    defaultMain,
    banUntil,
    missingFields,
  });
}

/** 取用户在赛季里的队长身份所在战队（非队长返回 null）。 */
async function captainTeamOf(seasonId: number, userId: number) {
  const membership = await prisma.teamSeasonMember.findFirst({
    where: { userId, team: { seasonId }, role: 'CAPTAIN' },
    include: { team: { include: { season: { select: { status: true } } } } },
  });
  return membership ?? null;
}

/** 赛事页报名名单：所有报名选手（含入队情况）+ 队长视角的邀请按钮所需信息。 */
export async function seasonSignupList(request: NextRequest, seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: { id: true, status: true, name: true },
  });
  if (!season) return NextResponse.json({ error: '战队赛不存在' }, { status: 404 });

  const [signups, memberships, user] = await Promise.all([
    prisma.teamSeasonSignup.findMany({
      where: { seasonId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { user: { include: { profile: true } } },
    }),
    prisma.teamSeasonMember.findMany({
      where: { team: { seasonId } },
      include: { team: { select: { id: true, name: true, abbr: true, logo: true } } },
    }),
    getSessionUser(request),
  ]);

  const memberByUser = new Map(memberships.map((m) => [m.userId, m]));

  const captain = user ? await captainTeamOf(seasonId, user.id) : null;
  let myTeam: {
    id: number;
    name: string;
    abbr: string;
    logo: string;
    members: {
      user_id: number;
      username: string;
      game_name: string;
      rank: string;
      avatar: string;
      role: string;
      position: string;
    }[];
    invites: {
      id: number;
      to_user_id: number;
      to_username: string;
      to_game_name: string;
      role: string;
      status: string;
    }[];
  } | null = null;

  if (captain) {
    const [members, invites] = await Promise.all([
      prisma.teamSeasonMember.findMany({
        where: { teamId: captain.team.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { user: { include: { profile: true } } },
      }),
      prisma.teamInvite.findMany({
        where: { teamId: captain.team.id },
        orderBy: { createdAt: 'desc' },
        include: {
          toUser: { select: { username: true, profile: { select: { gameName: true } } } },
        },
      }),
    ]);
    myTeam = {
      id: captain.team.id,
      name: captain.team.name,
      abbr: captain.team.abbr,
      logo: captain.team.logo,
      members: members.map((m) => ({
        user_id: m.userId,
        username: m.user.username,
        game_name: m.user.profile?.gameName ?? '',
        rank: m.user.profile?.rank ?? '',
        avatar: m.user.profile?.avatar ?? '',
        role: m.role,
        position: m.position,
      })),
      invites: invites.map((invite) => ({
        id: invite.id,
        to_user_id: invite.toUserId,
        to_username: invite.toUser.username,
        to_game_name: invite.toUser.profile?.gameName ?? '',
        role: invite.role,
        status: invite.status,
      })),
    };
  }

  return NextResponse.json({
    season: { id: season.id, name: season.name, status: season.status },
    viewer: captain
      ? { is_captain: true, team_id: captain.team.id, team_name: captain.team.name }
      : { is_captain: false, team_id: null, team_name: null },
    signups: signups.map((signup) => {
      const membership = memberByUser.get(signup.userId);
      return {
        user_id: signup.userId,
        username: signup.user.username,
        game_name: signup.user.profile?.gameName ?? '',
        rank: signup.user.profile?.rank ?? '',
        avatar: signup.user.profile?.avatar ?? '',
        main_position: signup.mainPosition,
        declaration: signup.declaration,
        team_id: membership?.team.id ?? null,
        team_name: membership?.team.name ?? null,
      };
    }),
    my_team: myTeam,
  });
}

/** 赛事页服务端数据：赛季概要 + 报名名单（含入队情况）+ 当前登录者视角（报名状态/队长身份）。 */
export async function getSeasonPageData(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    include: { _count: { select: { teams: true, signups: true } } },
  });
  if (!season) return null;

  const viewer = await getViewer();

  const [signups, memberships] = await Promise.all([
    prisma.teamSeasonSignup.findMany({
      where: { seasonId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { user: { include: { profile: true } } },
    }),
    prisma.teamSeasonMember.findMany({
      where: { team: { seasonId } },
      include: { team: { select: { id: true, name: true, abbr: true, logo: true } } },
    }),
  ]);
  const memberByUser = new Map(memberships.map((m) => [m.userId, m]));
  // 战队赛报名信息也要带出当前生效称号，统一徽章展示。
  const seasonTitleMap = await activeTitleMap(signups.map((signup) => signup.userId));
  const seasonNameplates = await activeNameplatesForUsers(signups.map((signup) => signup.user));

  let signed: { mainPosition: string; declaration: string } | null = null;
  if (viewer) {
    const signup = await prisma.teamSeasonSignup.findUnique({
      where: { seasonId_userId: { seasonId, userId: viewer.id } },
    });
    if (signup) signed = { mainPosition: signup.mainPosition, declaration: signup.declaration };
  }

  const membership = viewer
    ? await prisma.teamSeasonMember.findFirst({
        where: { userId: viewer.id, team: { seasonId } },
        include: { team: true },
      })
    : null;
  const isCaptain = membership?.role === 'CAPTAIN';

  // 战队列表：logo/名称/队长/成员 + 当前用户的申请状态（用于「查看战队」）。
  const [teamRows, myApplications] = await Promise.all([
    prisma.teamSeasonTeam.findMany({
      where: { seasonId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        members: {
          include: { user: { include: { profile: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    }),
    viewer
      ? prisma.teamApplication.findMany({
          where: { seasonId, fromUserId: viewer.id },
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve([]),
  ]);
  const applicationByTeam = new Map(myApplications.map((app) => [app.teamId, app]));
  const teams = teamRows.map((team) => {
    const captain = team.members.find((m) => m.role === 'CAPTAIN');
    const application = applicationByTeam.get(team.id);
    const members = team.members
      .filter((m) => m.role !== 'CAPTAIN')
      .map((m) => ({
        name: m.user.profile?.gameName ?? m.user.username,
        position: m.position,
        role: m.role,
      }));
    return {
      id: team.id,
      name: team.name,
      abbr: team.abbr,
      logo: team.logo,
      division: team.division,
      fees: {
        starter: team.members
          .filter((member) => member.role === 'CAPTAIN' || member.role === 'STARTER')
          .reduce((total, member) => total + rankFee(member.user.profile?.rank), 0),
        substitute: team.members
          .filter((member) => member.role === 'SUB')
          .reduce((total, member) => total + rankFee(member.user.profile?.rank), 0),
      },
      captain_username: captain?.user.username ?? '',
      captain_game_name: captain?.user.profile?.gameName ?? '',
      captain_position: captain?.position ?? '',
      has_captain: Boolean(captain),
      member_count: members.length,
      members,
      // 完整名单（含队长）：点击队标弹窗展示，带 user_id 供跳转个人主页。
      roster: team.members.map((m) => ({
        user_id: m.userId,
        username: m.user.username,
        game_name: m.user.profile?.gameName ?? '',
        rank: m.user.profile?.rank ?? '',
        avatar: m.user.profile?.avatar ?? '',
        position: m.position,
        role: m.role,
      })),
      viewer_is_member: team.members.some((m) => m.userId === viewer?.id),
      my_application: application ? { id: application.id, status: application.status } : null,
    };
  });

  let myTeam: {
    team_id: number;
    team_name: string;
    team_abbr: string;
    team_logo: string;
    is_captain: boolean;
    members: {
      user_id: number;
      username: string;
      game_name: string;
      rank: string;
      avatar: string;
      role: string;
      position: string;
    }[];
    invites: {
      id: number;
      to_user_id: number;
      to_username: string;
      to_game_name: string;
      role: string;
      status: string;
    }[];
  } | null = null;
  if (membership) {
    const team = membership.team;
    const [members, invites] = await Promise.all([
      prisma.teamSeasonMember.findMany({
        where: { teamId: team.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { user: { include: { profile: true } } },
      }),
      isCaptain
        ? prisma.teamInvite.findMany({
            where: { teamId: team.id },
            orderBy: { createdAt: 'desc' },
            include: {
              toUser: { select: { username: true, profile: { select: { gameName: true } } } },
            },
          })
        : Promise.resolve([]),
    ]);
    myTeam = {
      team_id: team.id,
      team_name: team.name,
      team_abbr: team.abbr,
      team_logo: team.logo,
      is_captain: isCaptain,
      members: members.map((m) => ({
        user_id: m.userId,
        username: m.user.username,
        game_name: m.user.profile?.gameName ?? '',
        rank: m.user.profile?.rank ?? '',
        avatar: m.user.profile?.avatar ?? '',
        role: m.role,
        position: m.position,
      })),
      invites: invites.map((invite) => ({
        id: invite.id,
        to_user_id: invite.toUserId,
        to_username: invite.toUser.username,
        to_game_name: invite.toUser.profile?.gameName ?? '',
        role: invite.role,
        status: invite.status,
      })),
    };
  }

  return {
    season: {
      id: season.id,
      name: season.name,
      status: season.status,
      start_date: season.startDate?.toISOString() ?? null,
      team_count: season._count.teams,
      signup_count: season._count.signups,
      // 赛事信息页展示冠军池（冠军/亚军/四强… 每人多少冠军币）。
      prize_pool_json: season.prizePoolJson,
    },
    players: signups.map((signup) => {
      const membership = memberByUser.get(signup.userId);
      return {
        id: signup.userId,
        name: signup.user.username,
        gameName: signup.user.profile?.gameName ?? '',
        position: signup.mainPosition,
        teamPosition: signup.mainPosition,
        rank: signup.user.profile?.rank ?? '',
        avatar: signup.user.profile?.avatar ?? '',
        avatarFrame: signup.user.avatarFrame,
        nameplate: seasonNameplates.get(signup.userId) ?? '',
        title: seasonTitleMap.get(signup.userId) ?? '',
        isWaitlisted: false,
        declaration: signup.declaration,
        team_id: membership?.team.id ?? null,
        team_name: membership?.team.name ?? null,
      };
    }),
    viewer: viewer
      ? {
          id: viewer.id,
          isCoreAdmin: viewer.isCoreAdmin,
          mainPosition: viewer.profile?.mainPosition ?? '',
          banUntil: viewer.banUntil ? viewer.banUntil.toISOString() : null,
          missingFields: missingSignupRequirements({
            gameName: viewer.profile?.gameName ?? '',
            mainPosition: viewer.profile?.mainPosition ?? '',
            rank: viewer.profile?.rank ?? '',
            kookName: viewer.kookName ?? '',
          }),
        }
      : null,
    signed,
    my_team: myTeam,
    teams,
    viewer_in_team: Boolean(membership),
  };
}

/** 队长邀请已报名选手入队（角色首发/替补，位置沿用报名分路）。 */
export async function inviteSeasonPlayer(request: NextRequest, seasonId: number) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const targetId = Number(body.userId);
  if (!Number.isInteger(targetId) || targetId < 1)
    return NextResponse.json({ error: '选手参数无效' }, { status: 400 });
  const requestedRole = body.role === 'SUB' ? 'SUB' : 'STARTER';

  const captain = await captainTeamOf(seasonId, user.id);
  if (!captain) return NextResponse.json({ error: '只有队长可以邀请选手' }, { status: 403 });
  const team = captain.team;
  if (team.season.status !== 'DRAFTING')
    return NextResponse.json({ error: '当前阶段不能邀请' }, { status: 409 });

  const signup = await prisma.teamSeasonSignup.findUnique({
    where: { seasonId_userId: { seasonId, userId: targetId } },
  });
  if (!signup) return NextResponse.json({ error: '该选手尚未报名' }, { status: 400 });
  const position = SEASON_POSITIONS.has(signup.mainPosition) ? signup.mainPosition : 'FILL';
  const alreadyMember = await prisma.teamSeasonMember.findFirst({
    where: { userId: targetId, team: { seasonId } },
  });
  if (alreadyMember) return NextResponse.json({ error: '该选手已在某支战队中' }, { status: 409 });

  const members = await prisma.teamSeasonMember.findMany({ where: { teamId: team.id } });
  const role = resolveSeasonJoinRole(requestedRole, members, position);
  if (role === 'SUB') {
    if (members.filter((m) => m.role === 'SUB').length >= 2)
      return NextResponse.json({ error: '替补已满（最多 2 名）' }, { status: 409 });
  }

  // 同一选手同一时间只保留一条待处理邀请：新的邀请覆盖旧的。
  const existing = await prisma.teamInvite.findFirst({
    where: { seasonId, toUserId: targetId, status: 'PENDING' },
  });
  if (existing) {
    await prisma.teamInvite.update({
      where: { id: existing.id },
      data: { teamId: team.id, fromUserId: user.id, role },
    });
  } else {
    await prisma.teamInvite.create({
      data: { seasonId, teamId: team.id, fromUserId: user.id, toUserId: targetId, role },
    });
  }
  return NextResponse.json({
    ok: true,
    message:
      requestedRole === 'STARTER' && role === 'SUB'
        ? '该位置已有首发或首发名额已满，已按替补身份发送邀请'
        : '邀请已发送',
  });
}

/** 选手接受/拒绝邀请；接受即入队（角色为邀请时约定，位置沿用报名分路）。 */
export async function respondSeasonInvite(request: NextRequest, inviteId: number) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const accept = body.accept === true;

  const invite = await prisma.teamInvite.findUnique({
    where: { id: inviteId },
    include: { team: { select: { id: true, name: true } } },
  });
  if (!invite || invite.toUserId !== user.id)
    return NextResponse.json({ error: '邀请不存在' }, { status: 404 });
  if (invite.status !== 'PENDING')
    return NextResponse.json({ error: '该邀请已处理' }, { status: 409 });

  const season = await prisma.teamSeason.findUnique({
    where: { id: invite.seasonId },
    select: { status: true },
  });
  if (season?.status !== 'DRAFTING')
    return NextResponse.json({ error: '当前阶段不能处理邀请' }, { status: 409 });

  if (!accept) {
    await prisma.teamInvite.update({ where: { id: inviteId }, data: { status: 'DECLINED' } });
    return NextResponse.json({ ok: true, message: '已拒绝邀请' });
  }

  const signup = await prisma.teamSeasonSignup.findUnique({
    where: { seasonId_userId: { seasonId: invite.seasonId, userId: user.id } },
  });
  const position =
    signup && SEASON_POSITIONS.has(signup.mainPosition) ? signup.mainPosition : 'FILL';

  const members = await prisma.teamSeasonMember.findMany({ where: { teamId: invite.teamId } });
  const already = await prisma.teamSeasonMember.findFirst({
    where: { userId: user.id, team: { seasonId: invite.seasonId } },
  });
  if (already) {
    await prisma.teamInvite.update({ where: { id: inviteId }, data: { status: 'DECLINED' } });
    return NextResponse.json({ error: '你已在其他战队中' }, { status: 409 });
  }
  const role = resolveSeasonJoinRole(invite.role === 'SUB' ? 'SUB' : 'STARTER', members, position);
  if (role === 'SUB' && members.filter((m) => m.role === 'SUB').length >= 2) {
    await prisma.teamInvite.update({ where: { id: inviteId }, data: { status: 'DECLINED' } });
    return NextResponse.json({ error: '该队替补已满，无法加入' }, { status: 409 });
  }

  await prisma.$transaction([
    prisma.teamSeasonMember.create({
      data: { teamId: invite.teamId, userId: user.id, role, position },
    }),
    prisma.teamInvite.update({
      where: { id: inviteId },
      data: { status: 'ACCEPTED', role },
    }),
  ]);
  return NextResponse.json({
    ok: true,
    message:
      invite.role === 'STARTER' && role === 'SUB'
        ? `该位置已有首发或首发名额已满，已按替补身份加入战队「${invite.team.name}」`
        : `已加入战队「${invite.team.name}」`,
  });
}

/** 选手申请加入战队（默认首发）；队长收到通知后通过/拒绝。无队长时提示。 */
export async function applyJoinTeam(request: NextRequest, seasonId: number) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const teamId = Number(body.teamId);
  if (!Number.isInteger(teamId) || teamId < 1)
    return NextResponse.json({ error: '战队参数无效' }, { status: 400 });

  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: { status: true },
  });
  if (!season) return NextResponse.json({ error: '战队赛不存在' }, { status: 404 });
  if (season.status !== 'DRAFTING')
    return NextResponse.json({ error: '当前阶段不能申请加入' }, { status: 409 });

  const team = await prisma.teamSeasonTeam.findUnique({
    where: { id: teamId },
    select: { id: true, seasonId: true, name: true },
  });
  if (!team || team.seasonId !== seasonId)
    return NextResponse.json({ error: '战队不存在' }, { status: 404 });

  const signup = await prisma.teamSeasonSignup.findUnique({
    where: { seasonId_userId: { seasonId, userId: user.id } },
  });
  if (!signup) return NextResponse.json({ error: '请先报名本次战队赛' }, { status: 400 });

  const alreadyMember = await prisma.teamSeasonMember.findFirst({
    where: { userId: user.id, team: { seasonId } },
  });
  if (alreadyMember) return NextResponse.json({ error: '你已在某支战队中' }, { status: 409 });

  const captain = await prisma.teamSeasonMember.findFirst({
    where: { teamId, role: 'CAPTAIN' },
    select: { userId: true },
  });
  if (!captain) return NextResponse.json({ error: '该队伍还没有队长' }, { status: 409 });

  // 允许同时申请多支战队；仅阻止对同一支战队重复提交待处理申请。
  const pending = await prisma.teamApplication.findFirst({
    where: { seasonId, teamId, fromUserId: user.id, status: 'PENDING' },
  });
  if (pending) return NextResponse.json({ error: '你已向该战队提交过申请' }, { status: 409 });

  const requestedRole = body.role === 'SUB' ? 'SUB' : 'STARTER';
  // 位置不再由申请时选择，沿用报名时选择的主位置。
  const position =
    signup && SEASON_POSITIONS.has(signup.mainPosition) ? signup.mainPosition : 'FILL';
  if (requestedRole === 'STARTER' && position === 'FILL')
    return NextResponse.json({ error: '报名时未选择位置' }, { status: 400 });

  const members = await prisma.teamSeasonMember.findMany({
    where: { teamId },
    select: { role: true, position: true, userId: true },
  });
  const role = resolveSeasonJoinRole(requestedRole, members, position);
  if (role === 'SUB') {
    if (members.filter((m) => m.role === 'SUB').length >= 2)
      return NextResponse.json({ error: '该队替补已满（最多 2 名）' }, { status: 409 });
  }

  await prisma.teamApplication.create({
    data: { seasonId, teamId, fromUserId: user.id, toUserId: captain.userId, role, position },
  });
  return NextResponse.json({
    ok: true,
    message:
      requestedRole === 'STARTER' && role === 'SUB'
        ? `该位置已有首发或首发名额已满，已按替补身份向「${team.name}」提交申请`
        : `已向「${team.name}」提交入队申请`,
  });
}

/** 队长处理入队申请：通过即入队（首发，位置沿用报名分路），拒绝则通知结果。 */
export async function respondApplication(request: NextRequest, applicationId: number) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const accept = body.accept === true;

  const application = await prisma.teamApplication.findUnique({
    where: { id: applicationId },
    include: { team: { select: { id: true, name: true } } },
  });
  if (!application || application.toUserId !== user.id)
    return NextResponse.json({ error: '申请不存在' }, { status: 404 });
  if (application.status !== 'PENDING')
    return NextResponse.json({ error: '该申请已处理' }, { status: 409 });

  const season = await prisma.teamSeason.findUnique({
    where: { id: application.seasonId },
    select: { status: true },
  });
  if (season?.status !== 'DRAFTING')
    return NextResponse.json({ error: '当前阶段不能处理申请' }, { status: 409 });

  if (!accept) {
    await prisma.teamApplication.update({
      where: { id: applicationId },
      data: { status: 'DECLINED' },
    });
    return NextResponse.json({ ok: true, message: '已拒绝申请' });
  }

  const applicant = await prisma.user.findUnique({
    where: { id: application.fromUserId },
    select: { username: true, profile: { select: { gameName: true } } },
  });
  const applicantName = applicant?.profile?.gameName || applicant?.username || '该选手';

  const signup = await prisma.teamSeasonSignup.findUnique({
    where: {
      seasonId_userId: { seasonId: application.seasonId, userId: application.fromUserId },
    },
  });
  const position = SEASON_POSITIONS.has(application.position)
    ? application.position
    : signup && SEASON_POSITIONS.has(signup.mainPosition)
      ? signup.mainPosition
      : 'FILL';

  const members = await prisma.teamSeasonMember.findMany({ where: { teamId: application.teamId } });
  const already = await prisma.teamSeasonMember.findFirst({
    where: { userId: application.fromUserId, team: { seasonId: application.seasonId } },
    include: { team: { select: { name: true } } },
  });
  if (already) {
    await prisma.teamApplication.update({
      where: { id: applicationId },
      data: { status: 'DECLINED' },
    });
    return NextResponse.json(
      { error: `该用户已经加入「${already.team.name}」战队` },
      { status: 409 },
    );
  }
  const role = resolveSeasonJoinRole(
    application.role === 'SUB' ? 'SUB' : 'STARTER',
    members,
    position,
  );
  if (role === 'SUB' && members.filter((m) => m.role === 'SUB').length >= 2) {
    await prisma.teamApplication.update({
      where: { id: applicationId },
      data: { status: 'DECLINED' },
    });
    return NextResponse.json({ error: '该队替补已满，无法加入' }, { status: 409 });
  }

  await prisma.$transaction([
    prisma.teamSeasonMember.create({
      data: {
        teamId: application.teamId,
        userId: application.fromUserId,
        role,
        position,
      },
    }),
    prisma.teamApplication.update({
      where: { id: applicationId },
      data: { status: 'ACCEPTED', role },
    }),
  ]);
  return NextResponse.json({
    ok: true,
    message:
      application.role === 'STARTER' && role === 'SUB'
        ? `该位置已有首发或首发名额已满，已将「${applicantName}」按替补加入`
        : `已通过「${applicantName}」的入队申请`,
  });
}

/** 全局通知：当前用户相关的邀请事件，分「当前（未读）」与「历史（已读）」，支持标记已读 / 删除。 */
export async function listMyInvites(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ login: false, current: [], history: [], unread_count: 0 });

  const [received, sent, notices, applicationsReceived, applicationsSent, sysNotifications] =
    await Promise.all([
      prisma.teamInvite.findMany({
        where: { toUserId: user.id, hiddenByTo: false },
        orderBy: { createdAt: 'desc' },
        include: {
          team: { select: { name: true } },
          season: { select: { name: true } },
          fromUser: { select: { username: true, profile: { select: { gameName: true } } } },
        },
      }),
      prisma.teamInvite.findMany({
        where: {
          fromUserId: user.id,
          hiddenByFrom: false,
          status: { in: ['ACCEPTED', 'DECLINED'] },
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          team: { select: { name: true } },
          season: { select: { name: true } },
          toUser: { select: { username: true, profile: { select: { gameName: true } } } },
        },
      }),
      prisma.teamNotice.findMany({
        where: { userId: user.id, hidden: false },
        orderBy: { createdAt: 'desc' },
        include: {
          season: { select: { name: true } },
          team: { select: { name: true } },
          refUser: { select: { username: true, profile: { select: { gameName: true } } } },
        },
      }),
      prisma.teamApplication.findMany({
        where: { toUserId: user.id, hiddenByTo: false },
        orderBy: { createdAt: 'desc' },
        include: {
          team: { select: { name: true } },
          season: { select: { name: true } },
          fromUser: { select: { username: true, profile: { select: { gameName: true } } } },
        },
      }),
      prisma.teamApplication.findMany({
        where: {
          fromUserId: user.id,
          hiddenByFrom: false,
          status: { in: ['ACCEPTED', 'DECLINED'] },
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          team: { select: { name: true } },
          season: { select: { name: true } },
          toUser: { select: { username: true, profile: { select: { gameName: true } } } },
        },
      }),
      prisma.userNotification.findMany({
        where: { userId: user.id, hidden: false },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

  const current: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const push = (item: Record<string, unknown>, read: boolean) =>
    (read ? history : current).push(item);

  for (const invite of received) {
    const read = invite.status !== 'PENDING' || invite.readByToAt !== null;
    push(
      {
        id: invite.id,
        source: 'invite',
        kind: 'received',
        season_name: invite.season.name,
        team_name: invite.team.name,
        role_label: roleLabel(invite.role),
        status: invite.status,
        status_label:
          invite.status === 'PENDING'
            ? '待处理'
            : invite.status === 'ACCEPTED'
              ? '已接受'
              : '已拒绝',
        peer_username: invite.fromUser.username,
        peer_game_name: invite.fromUser.profile?.gameName ?? '',
        created_at: invite.createdAt.toISOString(),
      },
      read,
    );
  }
  for (const invite of sent) {
    push(
      {
        id: invite.id,
        source: 'invite',
        kind: 'sent',
        season_name: invite.season.name,
        team_name: invite.team.name,
        role_label: roleLabel(invite.role),
        status: invite.status,
        status_label: invite.status === 'ACCEPTED' ? '已接受' : '已拒绝',
        peer_username: invite.toUser.username,
        peer_game_name: invite.toUser.profile?.gameName ?? '',
        created_at: invite.updatedAt.toISOString(),
      },
      invite.readByFromAt !== null,
    );
  }
  for (const notice of notices) {
    push(
      {
        id: notice.id,
        source: 'notice',
        kind: 'member_left',
        season_name: notice.season.name,
        team_name: notice.team.name,
        status: 'MEMBER_LEFT',
        status_label: '离开队伍',
        peer_username: notice.refUser.username,
        peer_game_name: notice.refUser.profile?.gameName ?? '',
        created_at: notice.createdAt.toISOString(),
      },
      notice.readAt !== null,
    );
  }
  for (const application of applicationsReceived) {
    const read = application.status !== 'PENDING' || application.readByToAt !== null;
    push(
      {
        id: application.id,
        source: 'application',
        kind: 'application_received',
        season_name: application.season.name,
        team_name: application.team.name,
        role_label: roleLabel(application.role),
        status: application.status,
        status_label:
          application.status === 'PENDING'
            ? '待处理'
            : application.status === 'ACCEPTED'
              ? '已通过'
              : '已拒绝',
        peer_username: application.fromUser.username,
        peer_game_name: application.fromUser.profile?.gameName ?? '',
        created_at: application.createdAt.toISOString(),
      },
      read,
    );
  }
  for (const application of applicationsSent) {
    push(
      {
        id: application.id,
        source: 'application',
        kind: 'application_sent',
        season_name: application.season.name,
        team_name: application.team.name,
        role_label: roleLabel(application.role),
        status: application.status,
        status_label: application.status === 'ACCEPTED' ? '已通过' : '已拒绝',
        peer_username: application.toUser.username,
        peer_game_name: application.toUser.profile?.gameName ?? '',
        created_at: application.updatedAt.toISOString(),
      },
      application.readByFromAt !== null,
    );
  }
  for (const notification of sysNotifications) {
    push(
      {
        id: notification.id,
        source: 'system',
        kind:
          notification.type === 'BET_RESULT'
            ? 'bet_result'
            : notification.type === 'PRIZE_GRANT'
              ? 'prize_grant'
              : notification.type === 'COMMUNITY_IMPORT'
                ? 'community_import'
                : 'point_recharge',
        title: notification.title,
        content: notification.content,
        status: notification.type,
        status_label: notification.title,
        season_name: '',
        team_name: '',
        peer_username: '',
        peer_game_name: '',
        created_at: notification.createdAt.toISOString(),
      },
      notification.readAt !== null,
    );
  }

  return NextResponse.json({
    login: true,
    current,
    history: history.slice(0, 50),
    unread_count: current.length,
  });
}

/** 标记某条通知已读（仅当前用户自己视角）。source=notice 走离开队伍通知，application 走入队申请，system 走系统通知，否则走邀请。 */
export async function markNotificationRead(
  userId: number,
  id: number,
  source: 'invite' | 'notice' | 'application' | 'system',
) {
  if (source === 'system') {
    await prisma.userNotification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
  if (source === 'notice') {
    await prisma.teamNotice.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
  if (source === 'application') {
    const application = await prisma.teamApplication.findUnique({ where: { id } });
    if (!application) throw notFound('通知不存在');
    if (application.toUserId === userId && application.readByToAt === null) {
      await prisma.teamApplication.update({ where: { id }, data: { readByToAt: new Date() } });
    } else if (application.fromUserId === userId && application.readByFromAt === null) {
      await prisma.teamApplication.update({ where: { id }, data: { readByFromAt: new Date() } });
    }
    return { ok: true };
  }
  const invite = await prisma.teamInvite.findUnique({ where: { id } });
  if (!invite) throw notFound('通知不存在');
  if (invite.toUserId === userId && invite.readByToAt === null) {
    await prisma.teamInvite.update({ where: { id }, data: { readByToAt: new Date() } });
  } else if (invite.fromUserId === userId && invite.readByFromAt === null) {
    await prisma.teamInvite.update({ where: { id }, data: { readByFromAt: new Date() } });
  }
  return { ok: true };
}

/** 删除某条通知（软删除，仅当前用户自己视角）。source=notice 走离开队伍通知，application 走入队申请，system 走系统通知，否则走邀请。 */
export async function deleteNotification(
  userId: number,
  id: number,
  source: 'invite' | 'notice' | 'application' | 'system',
) {
  if (source === 'system') {
    await prisma.userNotification.updateMany({ where: { id, userId }, data: { hidden: true } });
    return { ok: true };
  }
  if (source === 'notice') {
    await prisma.teamNotice.updateMany({ where: { id, userId }, data: { hidden: true } });
    return { ok: true };
  }
  if (source === 'application') {
    const application = await prisma.teamApplication.findUnique({ where: { id } });
    if (!application) throw notFound('通知不存在');
    if (application.toUserId === userId) {
      await prisma.teamApplication.update({ where: { id }, data: { hiddenByTo: true } });
    } else if (application.fromUserId === userId) {
      await prisma.teamApplication.update({ where: { id }, data: { hiddenByFrom: true } });
    }
    return { ok: true };
  }
  const invite = await prisma.teamInvite.findUnique({ where: { id } });
  if (!invite) throw notFound('通知不存在');
  if (invite.toUserId === userId) {
    await prisma.teamInvite.update({ where: { id }, data: { hiddenByTo: true } });
  } else if (invite.fromUserId === userId) {
    await prisma.teamInvite.update({ where: { id }, data: { hiddenByFrom: true } });
  }
  return { ok: true };
}
