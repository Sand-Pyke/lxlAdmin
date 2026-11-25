import { prisma } from '@/lib/prisma';
import { settleAllInCards } from '@/server/all-in-card';
import { badRequest, notFound } from '@/server/api';
import { isCoreAdminActor } from '@/server/permissions';
import { applyLedger } from '@/server/points';
import { SIX_TEAM_FORMAT, SIX_TEAM_FORMAT_V2 } from '@/lib/admin-options';
import {
  PRIZE_PLACE_LABELS,
  parsePrizePool,
  placeForFinalRank,
  prizePoolFromJson,
  serializePrizePool,
} from '@/lib/prize';

/**
 * 冠军池：赛事 / 赛季开赛前设置，按最终名次给参赛队员发放冠军币。
 * 配置的纯工具函数见 lib/prize（客户端可安全引用）。
 */

/** 解析冠军池配置并把校验错误转成业务错误。 */
function parsePoolOrThrow(input: unknown): Record<number, number> {
  try {
    return parsePrizePool(input);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : '冠军池配置无效');
  }
}

/** 常规赛某队名次档（1/2/4/6/8/16/32；0 表示未参赛）。 */
function regularTeamPlace(
  match: {
    bo: string;
    teamCount: number;
    championTeamId: number | null;
    runnerupTeamId: number | null;
  },
  teamId: number,
  rounds: { roundNo: number; teamOneId: number; teamTwoId: number }[],
): number {
  if (match.championTeamId === teamId) return 1;
  if (match.runnerupTeamId === teamId) return 2;
  const lastRound = rounds.reduce((max, row) => {
    if (row.teamOneId !== teamId && row.teamTwoId !== teamId) return max;
    return Math.max(max, row.roundNo);
  }, 0);
  if (!lastRound) return 0;
  if (match.bo === SIX_TEAM_FORMAT || match.bo === SIX_TEAM_FORMAT_V2) {
    if (lastRound === 1) return 6;
    if (lastRound === 2) return 4;
    return 0;
  }
  const totalRounds = Math.max(1, Math.round(Math.log2(Math.max(match.teamCount, 2))));
  const place = 2 ** (totalRounds - lastRound + 1);
  return place === 2 ? 2 : place;
}

// ---------- 设置冠军池 ----------

/** 设置常规赛冠军池：开赛（非 CREATED）后锁定，核心管理员不受限。 */
export async function setMatchPrizePool(matchId: number, input: unknown, actorId?: number) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) throw notFound('赛事不存在');
  const core = actorId != null && (await isCoreAdminActor(actorId));
  if (!core && match.status !== 'CREATED') throw badRequest('比赛已开始，冠军池不可再修改');

  const pool = parsePoolOrThrow(input);
  await prisma.match.update({
    where: { id: matchId },
    data: { prizePoolJson: serializePrizePool(pool) },
  });
  return { msg: '冠军池已保存', prize_pool: pool };
}

/** 设置战队赛冠军池：开赛（离开报名/选人阶段）后锁定，核心管理员不受限。 */
export async function setSeasonPrizePool(seasonId: number, input: unknown, actorId?: number) {
  const season = await prisma.teamSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw notFound('赛季不存在');
  const core = actorId != null && (await isCoreAdminActor(actorId));
  if (!core && !['SIGNUPS', 'DRAFTING'].includes(season.status))
    throw badRequest('赛季已开赛，冠军池不可再修改');

  const pool = parsePoolOrThrow(input);
  await prisma.teamSeason.update({
    where: { id: seasonId },
    data: { prizePoolJson: serializePrizePool(pool) },
  });
  return { msg: '冠军池已保存', prize_pool: pool };
}

// ---------- 发放 ----------

/** 常规赛发放冠军池（幂等）：按最终名次档给每位在队选手发对应金额。 */
export async function distributeMatchPrizes(matchId: number) {
  await settleAllInCards(matchId);
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      name: true,
      bo: true,
      teamCount: true,
      championTeamId: true,
      runnerupTeamId: true,
      prizePoolJson: true,
      prizeDistributed: true,
    },
  });
  if (!match || match.prizeDistributed) return { distributed: 0 };
  const pool = prizePoolFromJson(match.prizePoolJson);
  if (!Object.values(pool).some((amount) => amount > 0)) return { distributed: 0 };

  const [rounds, teams, signups] = await Promise.all([
    prisma.matchRound.findMany({ where: { matchId }, orderBy: { roundNo: 'asc' } }),
    prisma.team.findMany({ where: { matchId }, select: { id: true } }),
    prisma.matchSignup.findMany({
      where: { matchId, teamId: { not: null }, isWaitlisted: false },
      select: { userId: true, teamId: true },
    }),
  ]);

  const placeByTeam = new Map<number, number>();
  for (const team of teams) {
    const place = regularTeamPlace(match, team.id, rounds);
    if (place > 0) placeByTeam.set(team.id, place);
  }

  const recipients: { userId: number; amount: number; place: number }[] = [];
  for (const signup of signups) {
    const place = placeByTeam.get(signup.teamId!);
    const amount = place != null ? (pool[place] ?? 0) : 0;
    if (amount > 0 && place != null) recipients.push({ userId: signup.userId, amount, place });
  }
  if (recipients.length === 0) return { distributed: 0 };

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
    const current = await tx.match.findUnique({
      where: { id: matchId },
      select: { prizeDistributed: true },
    });
    if (!current || current.prizeDistributed) return;
    for (const recipient of recipients) {
      const label = PRIZE_PLACE_LABELS[recipient.place] ?? String(recipient.place);
      await applyLedger(
        tx,
        recipient.userId,
        recipient.amount,
        'PRIZE_GRANT',
        'PRIZE',
        matchId,
        label,
      );
      await tx.userNotification.create({
        data: {
          userId: recipient.userId,
          type: 'PRIZE_GRANT',
          title: '冠军池奖励',
          content: `「${match.name}」你所在队伍获得「${label}」，已发放 ${recipient.amount} 冠军币`,
        },
      });
    }
    await tx.match.update({ where: { id: matchId }, data: { prizeDistributed: true } });
  });

  return { distributed: recipients.length };
}

/** 战队赛发放冠军池（幂等）：按 finalRank → 名次档给每位队员发对应金额。 */
export async function distributeSeasonPrizes(seasonId: number) {
  const season = await prisma.teamSeason.findUnique({
    where: { id: seasonId },
    select: { id: true, name: true, prizePoolJson: true, prizeDistributed: true },
  });
  if (!season || season.prizeDistributed) return { distributed: 0 };
  const pool = prizePoolFromJson(season.prizePoolJson);
  if (!Object.values(pool).some((amount) => amount > 0)) return { distributed: 0 };

  const teams = await prisma.teamSeasonTeam.findMany({
    where: { seasonId },
    select: { id: true, finalRank: true },
  });
  const members = await prisma.teamSeasonMember.findMany({
    where: { teamId: { in: teams.map((team) => team.id) } },
    select: { userId: true, teamId: true },
  });

  const placeByTeam = new Map<number, number>();
  for (const team of teams) {
    if (team.finalRank != null) placeByTeam.set(team.id, placeForFinalRank(team.finalRank));
  }

  const recipients: { userId: number; amount: number; place: number }[] = [];
  for (const member of members) {
    const place = placeByTeam.get(member.teamId);
    const amount = place != null ? (pool[place] ?? 0) : 0;
    if (amount > 0 && place != null) recipients.push({ userId: member.userId, amount, place });
  }
  if (recipients.length === 0) return { distributed: 0 };

  await prisma.$transaction(async (tx) => {
    const current = await tx.teamSeason.findUnique({
      where: { id: seasonId },
      select: { prizeDistributed: true },
    });
    if (!current || current.prizeDistributed) return;
    for (const recipient of recipients) {
      const label = PRIZE_PLACE_LABELS[recipient.place] ?? String(recipient.place);
      await applyLedger(
        tx,
        recipient.userId,
        recipient.amount,
        'PRIZE_GRANT',
        'PRIZE',
        seasonId,
        label,
      );
      await tx.userNotification.create({
        data: {
          userId: recipient.userId,
          type: 'PRIZE_GRANT',
          title: '冠军池奖励',
          content: `「${season.name}」你所在战队获得「${label}」，已发放 ${recipient.amount} 冠军币`,
        },
      });
    }
    await tx.teamSeason.update({ where: { id: seasonId }, data: { prizeDistributed: true } });
  });

  return { distributed: recipients.length };
}
