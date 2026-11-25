import type { Prisma, Match, MatchGameRecord, MatchScore, MatchSignup, Team } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { RANK_FEES, reducedDraftRank } from '@/lib/fee-reduction';
import { badRequest } from '@/server/api';
import {
  EIGHT_TEAM_FORMAT,
  EIGHT_TEAM_FORMAT_V2,
  SIX_TEAM_FORMAT,
  SIX_TEAM_FORMAT_V2,
} from '@/lib/admin-options';
import { statusStillBlocked } from '@/server/permissions';
import { awardHeroProtectionCard } from '@/server/hero-protection';
import { settleMarketsForRegularScore } from '@/server/market-settlement';
import { distributeMatchPrizes } from '@/server/prize';
import {
  activeMatchTeamWhere,
  assertCaptainTeamsReady,
  cleanupCaptainLogo,
} from '@/server/captain-teams';

/**
 * 队伍、轮次与比分的领域逻辑（迁移自原 Flask 服务的 _pair_teams / rank_fee /
 * match_budget / _score_map / _get_score / _team_score）。
 */

export const POSITIONS = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'] as const;
export type Position = (typeof POSITIONS)[number];

export function isPosition(value: unknown): value is Position {
  return typeof value === 'string' && (POSITIONS as readonly string[]).includes(value);
}

// 未定段/空 = 0；降费卡只改变排序，不改变这里的真实费用。
export function rankFee(rank: string | null | undefined) {
  return RANK_FEES[rank ?? ''] ?? 0;
}

type SignWithRank = MatchSignup & { user?: { profile?: { rank: string } | null } | null };

/** 报名记录的有效段位：优先用户当前段位（改段位后实时生效），回退到报名快照。 */
export function signRank(sign: SignWithRank) {
  return sign.user?.profile?.rank || sign.rankAtSignup || '';
}

/** 每队动态预算 = ceil(选手池总费用 / 队伍数) + 1 宽松费（防止预算卡死凑不齐 5 人）。 */
export async function matchBudget(matchId: number, db: Prisma.TransactionClient = prisma) {
  const [signs, teamCount] = await Promise.all([
    db.matchSignup.findMany({
      where: { matchId, isWaitlisted: false },
      include: { user: { include: { profile: { select: { rank: true } } } } },
    }),
    db.team.count({ where: activeMatchTeamWhere(matchId) }),
  ]);
  const total = signs.reduce((sum, sign) => sum + rankFee(signRank(sign)), 0);
  if (teamCount <= 0) return Math.max(total, 1);
  return Math.max(1, Math.ceil(total / teamCount) + 1);
}

export type TeamPair = [number, number | null];

/** 对阵配对：手动选的对战排第一，其余队伍继续两两配对（缺队补 null → 待定）。 */
export function pairTeams(
  match: Pick<Match, 'teamOneId' | 'teamTwoId'>,
  teams: Pick<Team, 'id'>[],
): TeamPair[] {
  const teamIds = new Set(teams.map((team) => team.id));
  const pairs: TeamPair[] = [];
  let used = new Set<number>();

  if (
    match.teamOneId &&
    match.teamTwoId &&
    teamIds.has(match.teamOneId) &&
    teamIds.has(match.teamTwoId)
  ) {
    pairs.push([match.teamOneId, match.teamTwoId]);
    used = new Set([match.teamOneId, match.teamTwoId]);
  }

  const rest = teams.filter((team) => !used.has(team.id)).map((team) => team.id);
  for (let index = 0; index < rest.length; index += 2) {
    pairs.push([rest[index], rest[index + 1] ?? null]);
  }

  if (!pairs.length && teams.length) {
    pairs.push([teams[0].id, teams[1]?.id ?? null]);
  }
  return pairs;
}

type ScoreMap = Map<string, [number, number]>;

type ScoreRow = Pick<MatchScore, 'roundNo' | 'teamOneId' | 'teamTwoId' | 'scoreOne' | 'scoreTwo'>;

const scoreKey = (roundNo: number, teamOneId: number, teamTwoId: number) =>
  `${roundNo}:${teamOneId}:${teamTwoId}`;

/** 手动战果查找表（优先于按战绩统计）。 */
export function scoreMap(scores: ScoreRow[]): ScoreMap {
  const map: ScoreMap = new Map();
  for (const score of scores) {
    map.set(scoreKey(score.roundNo, score.teamOneId, score.teamTwoId), [
      score.scoreOne,
      score.scoreTwo,
    ]);
  }
  return map;
}

type ScoreRecord = Pick<MatchGameRecord, 'userId' | 'gameNo' | 'result'>;

/** 对阵比分：按小局统计两队各自 win 数（小局内同队多名胜者算 1 分）。 */
export function teamScore(
  records: ScoreRecord[],
  userTeam: Map<number, number>,
  teamOneId: number,
  teamTwoId: number | null,
): [number, number] {
  const games = new Map<number, ScoreRecord[]>();
  for (const record of records) {
    const teamId = userTeam.get(record.userId);
    if (teamId !== teamOneId && teamId !== teamTwoId) continue;
    const bucket = games.get(record.gameNo) ?? [];
    bucket.push(record);
    games.set(record.gameNo, bucket);
  }

  let scoreOne = 0;
  let scoreTwo = 0;
  for (const [, gameRecords] of [...games].sort((a, b) => a[0] - b[0])) {
    const winsOne = gameRecords.filter(
      (r) => r.result === 'win' && userTeam.get(r.userId) === teamOneId,
    ).length;
    const winsTwo = gameRecords.filter(
      (r) => r.result === 'win' && userTeam.get(r.userId) === teamTwoId,
    ).length;
    if (winsOne > winsTwo) scoreOne += 1;
    else if (winsTwo > winsOne) scoreTwo += 1;
  }
  return [scoreOne, scoreTwo];
}

/** 取比分：手动设置的战果优先，否则按战绩统计。 */
export function resolveScore(
  map: ScoreMap,
  roundNo: number,
  teamOneId: number,
  teamTwoId: number | null,
  records: ScoreRecord[],
  userTeam: Map<number, number>,
): [number, number] {
  if (teamTwoId === null) return [0, 0];
  const direct = map.get(scoreKey(roundNo, teamOneId, teamTwoId));
  if (direct) return direct;
  const swapped = map.get(scoreKey(roundNo, teamTwoId, teamOneId));
  if (swapped) return [swapped[1], swapped[0]];
  return teamScore(records, userTeam, teamOneId, teamTwoId);
}

/** 单败淘汰允许的队伍数：2/4/8/16/32。 */
const VALID_TEAM_COUNTS = [2, 4, 6, 8, 16, 32];

export function isBracketTeamCount(count: number) {
  return VALID_TEAM_COUNTS.includes(count);
}

/** 单败淘汰总轮数 = log2(队伍数)，最少 1 轮。 */
export function totalRoundsFor(teamCount: number) {
  return Math.max(1, Math.round(Math.log2(Math.max(teamCount, 2))));
}

/**
 * 结束本轮：校验本轮全部对阵都已录入系列比分且分出胜负，固化本轮对阵，
 * 并把各组胜者按顺序配对成下一轮；只剩一组（决赛）时判定冠军并结束赛事。
 */
export async function endRound(
  matchId: number,
  wildcardTeamId?: number,
  actorId?: number,
  expectedRoundNo?: number,
) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return { kind: 'not_found' as const };
  if (expectedRoundNo !== undefined && match.currentRound !== expectedRoundNo)
    return { kind: 'stale_round' as const };
  if (await statusStillBlocked(actorId, match.status === 'CREATED'))
    return { kind: 'not_started' as const };
  if (await statusStillBlocked(actorId, match.status === 'FINISHED'))
    return { kind: 'already_finished' as const };

  const teams = await prisma.team.findMany({
    where: activeMatchTeamWhere(matchId),
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const sixTeamMode = match.bo === SIX_TEAM_FORMAT || match.bo === SIX_TEAM_FORMAT_V2;
  const eightTeamMode = match.bo === EIGHT_TEAM_FORMAT || match.bo === EIGHT_TEAM_FORMAT_V2;
  if (
    sixTeamMode
      ? teams.length !== 6
      : eightTeamMode
        ? teams.length !== 8
        : !isBracketTeamCount(teams.length) || teams.length === 6
  ) {
    return { kind: 'bad_team_count' as const };
  }

  const roundNo = match.currentRound || 1;
  if (roundNo > totalRoundsFor(teams.length)) return { kind: 'already_finished' as const };

  // 当前轮对阵：优先用已固化的 MatchRound；第 1 轮未固化时按队伍顺序现场生成。
  const frozen = await prisma.matchRound.findMany({
    where: { matchId, roundNo },
    orderBy: { id: 'asc' },
  });
  const pairs: [number, number][] = frozen.length
    ? frozen.map((row) => [row.teamOneId, row.teamTwoId] as [number, number])
    : pairTeams(match, teams).filter((pair): pair is [number, number] => pair[1] !== null);
  if (!pairs.length) return { kind: 'empty' as const };

  const map = scoreMap(
    await prisma.matchScore.findMany({
      where: { matchId, roundNo },
      select: { roundNo: true, teamOneId: true, teamTwoId: true, scoreOne: true, scoreTwo: true },
    }),
  );

  const winners: number[] = [];
  const losers: number[] = [];
  for (const [teamOneId, teamTwoId] of pairs) {
    const direct = map.get(scoreKey(roundNo, teamOneId, teamTwoId));
    const swapped = map.get(scoreKey(roundNo, teamTwoId, teamOneId));
    let scoreOne: number;
    let scoreTwo: number;
    if (direct) {
      scoreOne = direct[0];
      scoreTwo = direct[1];
    } else if (swapped) {
      scoreOne = swapped[1];
      scoreTwo = swapped[0];
    } else {
      return { kind: 'no_score' as const };
    }
    if (scoreOne === scoreTwo) return { kind: 'tie' as const };
    winners.push(scoreOne > scoreTwo ? teamOneId : teamTwoId);
    losers.push(scoreOne > scoreTwo ? teamTwoId : teamOneId);
  }

  if (sixTeamMode && roundNo === 1) {
    if (wildcardTeamId === undefined) return { kind: 'wildcard_required' as const };
    if (!losers.includes(wildcardTeamId)) return { kind: 'invalid_wildcard' as const };
  }

  const lockRound = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
    const current = await tx.match.findUnique({
      where: { id: matchId },
      select: { currentRound: true, status: true },
    });
    if (!current || current.currentRound !== roundNo || current.status !== match.status)
      throw badRequest('赛事轮次或状态已变化，请刷新后重试');
  };

  if (pairs.length === 1) {
    // 决赛：冠军出炉，赛事结束。
    const [finalTeamOneId, finalTeamTwoId] = pairs[0];
    const championTeamId = winners[0];
    const runnerupTeamId = championTeamId === finalTeamOneId ? finalTeamTwoId : finalTeamOneId;
    const finalSignups = await prisma.matchSignup.findMany({
      where: {
        matchId,
        teamId: { in: [championTeamId, runnerupTeamId] },
      },
      select: { userId: true, teamId: true },
    });
    await prisma.$transaction(async (tx) => {
      await lockRound(tx);
      await tx.matchRound.deleteMany({ where: { matchId, roundNo } });
      await tx.matchRound.createMany({
        data: pairs.map(([teamOneId, teamTwoId]) => ({
          matchId,
          roundNo,
          teamOneId,
          teamTwoId,
        })),
      });
      await Promise.all(
        finalSignups.map((signup) =>
          tx.matchGameRecord.updateMany({
            where: { matchId, userId: signup.userId },
            data: { teamRank: signup.teamId === championTeamId ? 1 : 2 },
          }),
        ),
      );
      await tx.match.update({
        where: { id: matchId },
        data: {
          status: 'FINISHED',
          roundEnded: true,
          championTeamId,
          runnerupTeamId,
        },
      });
      // 原有夺冠返卡：任一轮实际用卡的冠军队选手，每人每赛事仍只奖励一张。
      const winningProtections = await tx.matchHeroProtection.findMany({
        where: {
          matchId,
          teamId: championTeamId,
          ownerId: {
            in: finalSignups.filter((s) => s.teamId === championTeamId).map((s) => s.userId),
          },
          card: { consumedAt: { not: null } },
        },
        distinct: ['ownerId'],
        select: { ownerId: true },
      });
      for (const protection of winningProtections)
        await awardHeroProtectionCard(tx, protection.ownerId, matchId, 'CHAMPION');
    });
    // 冠军池发放（best-effort）：决赛固化名次后按最终名次给参赛队员发冠军币。
    await distributeMatchPrizes(matchId).catch(() => undefined);
    return { kind: 'ok' as const, roundNo, finished: true, championTeamId };
  }

  // 半决赛及之前：胜者按顺序两两配对成下一轮。
  const nextRound = roundNo + 1;
  const nextPairs: {
    matchId: number;
    roundNo: number;
    teamOneId: number;
    teamTwoId: number;
  }[] = [];
  if (sixTeamMode && roundNo === 1) {
    // 六队模式：3 名胜者 + 1 张外卡晋级半决赛。
    // 外卡不能和它首轮所在对阵的胜者再次交手，因此让外卡对阵「不同组的胜者」，
    // 其余两名胜者互相配对（外卡对阵固定放第二组，与展示顺序保持一致）。
    const wildcardGroup = pairs.findIndex(([a, b]) => a === wildcardTeamId || b === wildcardTeamId);
    const wildcardOpponent = winners.find((_, index) => index !== wildcardGroup);
    const remaining = winners.filter((winner) => winner !== wildcardOpponent);
    nextPairs.push({
      matchId,
      roundNo: nextRound,
      teamOneId: remaining[0],
      teamTwoId: remaining[1],
    });
    nextPairs.push({
      matchId,
      roundNo: nextRound,
      teamOneId: wildcardOpponent!,
      teamTwoId: wildcardTeamId!,
    });
  } else {
    for (let index = 0; index < winners.length; index += 2) {
      if (winners[index + 1] === undefined) continue;
      nextPairs.push({
        matchId,
        roundNo: nextRound,
        teamOneId: winners[index],
        teamTwoId: winners[index + 1],
      });
    }
  }
  await prisma.$transaction(async (tx) => {
    await lockRound(tx);
    await tx.matchRound.deleteMany({ where: { matchId, roundNo } });
    await tx.matchRound.createMany({
      data: pairs.map(([teamOneId, teamTwoId]) => ({ matchId, roundNo, teamOneId, teamTwoId })),
    });
    await tx.matchRound.deleteMany({ where: { matchId, roundNo: nextRound } });
    await tx.matchRound.createMany({ data: nextPairs });
    await tx.match.update({
      where: { id: matchId },
      data: { currentRound: nextRound, roundEnded: true },
    });
  });
  return { kind: 'ok' as const, roundNo, finished: false, championTeamId: null };
}

/** 手动设置某轮对战战果（几比几）。 */
export async function setScore(input: {
  matchId: number;
  roundNo: number;
  teamOneId: number;
  teamTwoId: number;
  scoreOne: number;
  scoreTwo: number;
}) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Match" WHERE "id" = ${input.matchId} FOR UPDATE`;
      const { matchId, roundNo, teamOneId, teamTwoId, scoreOne, scoreTwo } = input;
      const direct = await tx.matchScore.findUnique({
        where: {
          matchId_roundNo_teamOneId_teamTwoId: { matchId, roundNo, teamOneId, teamTwoId },
        },
      });
      if (direct) {
        await tx.matchScore.update({
          where: { id: direct.id },
          data: { scoreOne, scoreTwo },
        });
        await settleMarketsForRegularScore(tx, input);
        return;
      }

      const swapped = await tx.matchScore.findUnique({
        where: {
          matchId_roundNo_teamOneId_teamTwoId: {
            matchId,
            roundNo,
            teamOneId: teamTwoId,
            teamTwoId: teamOneId,
          },
        },
      });
      if (swapped) {
        await tx.matchScore.update({
          where: { id: swapped.id },
          data: { scoreOne: scoreTwo, scoreTwo: scoreOne },
        });
        await settleMarketsForRegularScore(tx, input);
        return;
      }

      await tx.matchScore.create({
        data: { matchId, roundNo, teamOneId, teamTwoId, scoreOne, scoreTwo },
      });
      await settleMarketsForRegularScore(tx, input);
    },
    { timeout: 30000 },
  );
}

/** 原地洗牌；随后依赖稳定排序保留完全相同条件下的随机次序。 */
function shuffle<T>(items: T[]) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

/**
 * 一轮手动选人全部录完后更新下一轮选人顺位。
 * 每轮结束都按累计费用升序重新生成顺位，同费随机；降费卡只影响队长就位后的首轮排序。
 */
export async function reorderDraftAfterCompletedRound(
  matchId: number,
  transaction?: Prisma.TransactionClient,
  draftTeamIds?: readonly number[],
): Promise<boolean> {
  if (!transaction) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Match" WHERE "id" = ${matchId} FOR UPDATE`;
      return reorderDraftAfterCompletedRound(matchId, tx, draftTeamIds);
    });
  }
  const db = transaction;
  const [teams, signs, match] = await Promise.all([
    db.team.findMany({
      where: {
        ...activeMatchTeamWhere(matchId),
        ...(draftTeamIds ? { id: { in: [...draftTeamIds] } } : {}),
      },
      orderBy: [{ draftOrder: 'asc' }, { id: 'asc' }],
    }),
    db.matchSignup.findMany({
      where: { matchId, teamId: { not: null }, isWaitlisted: false },
      include: { user: { include: { profile: { select: { rank: true } } } } },
      orderBy: [{ positionOrder: 'asc' }, { id: 'asc' }],
    }),
    db.match.findUniqueOrThrow({ where: { id: matchId } }),
  ]);
  if (!teams.length) return false;

  const members = new Map<number, typeof signs>();
  for (const sign of signs) {
    if (!sign.teamId) continue;
    const teamMembers = members.get(sign.teamId) ?? [];
    teamMembers.push(sign);
    members.set(sign.teamId, teamMembers);
  }

  const memberCounts = teams.map((team) => members.get(team.id)?.length ?? 0);
  const completedRound = memberCounts[0];
  // 只有每队人数相等时才代表本轮录入完成；此时立即更新下一轮顺位。
  if (!completedRound || !memberCounts.every((count) => count === completedRound)) {
    return false;
  }

  // 队长就位（每队1人）后生成首轮选人顺位；每队选入第2人后进入第二轮。
  const firstRound = completedRound === 1 && !match.feeCardFirstRoundDone;

  const nextOrder = shuffle(
    teams.map((team) => {
      const teamMembers = members.get(team.id) ?? [];
      const usedFee = teamMembers.reduce((sum, member) => sum + rankFee(signRank(member)), 0);
      const captain = teamMembers.find((member) => member.isCaptain) ?? teamMembers[0];
      const originalRank = signRank(captain);
      const reduced =
        firstRound && captain.feeCardInventoryId ? reducedDraftRank(originalRank) : null;
      return {
        team,
        // 仅排序分数临时扣减，matchBudget / teamUsage / 分配预算校验仍用真实费用。
        draftFee: usedFee - (reduced ? rankFee(originalRank) - reduced.fee : 0),
      };
    }),
  ).sort((a, b) => a.draftFee - b.draftFee);

  const write = async (tx: Prisma.TransactionClient) => {
    await Promise.all(
      nextOrder.map(({ team }, index) =>
        tx.team.update({ where: { id: team.id }, data: { draftOrder: index + 1 } }),
      ),
    );
    if (firstRound)
      await tx.userInventory.updateMany({
        where: {
          status: 'RESERVED',
          feeCardSignup: { matchId, isWaitlisted: false, teamId: { not: null } },
        },
        data: { status: 'USED', usedAt: new Date() },
      });
    if (completedRound >= 2 && !match.feeCardFirstRoundDone)
      await tx.match.update({
        where: { id: matchId },
        data: { feeCardFirstRoundDone: true },
      });
  };
  await write(transaction);
  return true;
}

/** 队伍名映射 + 每队已用费用。 */
export async function teamUsage(matchId: number) {
  const [teams, signs] = await Promise.all([
    prisma.team.findMany({
      where: activeMatchTeamWhere(matchId),
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
    prisma.matchSignup.findMany({
      where: { matchId, isWaitlisted: false },
      include: { user: { include: { profile: { select: { rank: true } } } } },
    }),
  ]);
  const usedFee = new Map<number, number>();
  const memberCount = new Map<number, number>();
  for (const sign of signs) {
    if (!sign.teamId) continue;
    usedFee.set(sign.teamId, (usedFee.get(sign.teamId) ?? 0) + rankFee(signRank(sign)));
    memberCount.set(sign.teamId, (memberCount.get(sign.teamId) ?? 0) + 1);
  }
  return { teams, signs, usedFee, memberCount };
}

async function syncTeamCount(matchId: number) {
  const teamCount = await prisma.team.count({ where: activeMatchTeamWhere(matchId) });
  await prisma.match.update({ where: { id: matchId }, data: { teamCount } });
}

/** 队长固定为首位选入的成员；若队长离队，当前队内最早选入者自动接任。 */
async function ensureTeamCaptain(teamId: number, db: Prisma.TransactionClient = prisma) {
  const team = await db.team.findUnique({ where: { id: teamId }, include: { match: true } });
  if (team?.match.captainPosition) {
    await db.matchSignup.updateMany({ where: { teamId }, data: { isCaptain: false } });
    await db.matchSignup.updateMany({
      where: { teamId, mainPosition: team.match.captainPosition },
      data: { isCaptain: true },
    });
    return;
  }
  const members = await db.matchSignup.findMany({
    where: { teamId },
    select: { id: true, isCaptain: true },
    orderBy: [{ positionOrder: 'asc' }, { id: 'asc' }],
  });
  if (!members.length || members.some((member) => member.isCaptain)) return;
  await db.matchSignup.update({ where: { id: members[0].id }, data: { isCaptain: true } });
}

export async function createTeam(matchId: number, name: string, actorId?: number) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return { kind: 'match_not_found' as const };
  if (await statusStillBlocked(actorId, match.status !== 'CREATED'))
    return { kind: 'match_started' as const };
  // 新队伍顺位排到末尾（当前最大 sortOrder + 1）。
  const maxOrder = await prisma.team.aggregate({
    where: { matchId },
    _max: { sortOrder: true, draftOrder: true },
  });
  const sortOrder = (maxOrder._max.sortOrder ?? 0) + 1;
  const draftOrder = (maxOrder._max.draftOrder ?? 0) + 1;
  try {
    await prisma.team.create({ data: { matchId, name, sortOrder, draftOrder } });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return { kind: 'duplicate' as const };
    throw error;
  }
  await syncTeamCount(matchId);
  return { kind: 'ok' as const };
}

export async function deleteTeam(teamId: number, actorId?: number) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) return { kind: 'not_found' as const };
  const match = await prisma.match.findUnique({ where: { id: team.matchId } });
  if (!match) return { kind: 'match_not_found' as const };
  if (await statusStillBlocked(actorId, match.status !== 'CREATED'))
    return { kind: 'match_started' as const };
  // 队员移回未分配（外键为 SetNull，这里显式清空位置槽以便前端立即反映）
  await prisma.$transaction(async (tx) => {
    if (team.captainSignupId)
      await tx.matchSignup.update({
        where: { id: team.captainSignupId },
        data: { captainTeamName: '', captainTeamLogo: '' },
      });
    const signups = await tx.matchSignup.findMany({
      where: { teamId },
      select: { id: true, isWaitlisted: true, waitlistOrigin: true },
    });
    await Promise.all(
      signups.map((signup) =>
        tx.matchSignup.update({
          where: { id: signup.id },
          data: {
            teamId: null,
            teamPosition: '',
            positionOrder: 0,
            isCaptain: false,
            isWaitlisted: signup.isWaitlisted || signup.waitlistOrigin,
          },
        }),
      ),
    );
    await tx.team.delete({ where: { id: teamId } });
  });
  await syncTeamCount(team.matchId);
  if (team.captainSignupId) await cleanupCaptainLogo(team.logo);
  return { kind: 'ok' as const };
}

/** 重排队伍顺位：按传入的 teamIds 顺序写入 sortOrder（1..n），决定对战配对顺序。 */
export async function reorderTeams(matchId: number, teamIds: number[], actorId?: number) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return { kind: 'match_not_found' as const };
  if (await statusStillBlocked(actorId, match.status !== 'CREATED'))
    return { kind: 'match_started' as const };
  const teams = await prisma.team.findMany({
    where: activeMatchTeamWhere(matchId),
    select: { id: true },
  });
  if (teams.length !== teamIds.length || new Set(teamIds).size !== teamIds.length) {
    return { kind: 'team_mismatch' as const };
  }
  const idSet = new Set(teams.map((team) => team.id));
  if (!teamIds.every((id) => idSet.has(id))) return { kind: 'team_mismatch' as const };
  const counts = await prisma.matchSignup.groupBy({
    by: ['teamId'],
    where: { matchId, teamId: { in: teams.map((team) => team.id) } },
    _count: { _all: true },
  });
  const countByTeam = new Map(counts.map((row) => [row.teamId, row._count._all]));
  if (teams.some((team) => (countByTeam.get(team.id) ?? 0) < 5)) {
    return { kind: 'not_ready' as const };
  }
  await prisma.$transaction(
    teamIds.map((id, index) =>
      prisma.team.update({ where: { id }, data: { sortOrder: index + 1 } }),
    ),
  );
  return { kind: 'ok' as const };
}

/** 把报名记录分配到队伍/位置槽。目标位置已有人时自动互换位置。 */
type AssignSignupInput = {
  signId: number;
  teamId: number | null;
  teamPosition: string | null;
  /** 临时预算覆盖（仅本次分配生效）：预算不足时由管理员临时调额后传入。 */
  overrideBudget?: number;
  /** 后台操作者：核心管理员可绕过赛事状态限制。 */
  actorId?: number;
  /** 大屏当前参与选人的队伍，避免未勾选的空队伍阻止轮次结束。 */
  draftTeamIds?: number[];
};

export async function assignSignup(input: AssignSignupInput) {
  const sign = await prisma.matchSignup.findUnique({
    where: { id: input.signId },
    select: { matchId: true },
  });
  if (!sign) return { kind: 'sign_not_found' as const };
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Match" WHERE "id" = ${sign.matchId} FOR UPDATE`;
      if (input.draftTeamIds) {
        const ids = input.draftTeamIds;
        if (
          ids.length < 2 ||
          new Set(ids).size !== ids.length ||
          (input.teamId !== null && !ids.includes(input.teamId))
        )
          throw badRequest('选人队伍范围无效');
        const count = await tx.team.count({ where: { matchId: sign.matchId, id: { in: ids } } });
        if (count !== ids.length) throw badRequest('选人队伍不属于本场赛事');
      }
      return assignSignupInTransaction(input, tx);
    },
    { timeout: 15000 },
  );
}

async function assignSignupInTransaction(input: AssignSignupInput, tx: Prisma.TransactionClient) {
  const { signId, teamId } = input;
  const sign = await tx.matchSignup.findUnique({
    where: { id: signId },
    include: { user: { include: { profile: { select: { rank: true } } } } },
  });
  if (!sign) return { kind: 'sign_not_found' as const };
  const signMatch = await tx.match.findUnique({
    where: { id: sign.matchId },
    select: { status: true },
  });
  if (!signMatch) return { kind: 'match_not_found' as const };
  if (await statusStillBlocked(input.actorId, signMatch.status !== 'CREATED'))
    return { kind: 'match_started' as const };
  const wasUnassigned = sign.teamId === null;

  if (teamId === null) {
    await tx.matchSignup.update({
      where: { id: signId },
      data: {
        teamId: null,
        teamPosition: '',
        positionOrder: 0,
        isCaptain: false,
        isWaitlisted: sign.isWaitlisted || sign.waitlistOrigin,
      },
    });
    if (sign.teamId) await ensureTeamCaptain(sign.teamId, tx);
    return { kind: 'ok' as const };
  }

  const [team, match] = await Promise.all([
    tx.team.findUnique({ where: { id: teamId } }),
    tx.match.findUnique({ where: { id: sign.matchId } }),
  ]);
  if (!team || team.matchId !== sign.matchId) return { kind: 'team_mismatch' as const };
  if (!match) return { kind: 'match_not_found' as const };
  await assertCaptainTeamsReady(tx, sign.matchId);
  if (
    team.captainSignupId &&
    sign.mainPosition === match.captainPosition &&
    team.captainSignupId !== sign.id
  )
    throw badRequest('队长只能加入自己设置的队伍');

  if (match.captainPosition) {
    const isCaptain = sign.mainPosition === match.captainPosition;
    if (!isCaptain && !(await tx.matchSignup.count({ where: { teamId } })))
      throw badRequest('请先将本场指定分路的队长分配到该队');
    if (
      isCaptain &&
      (await tx.matchSignup.count({
        where: { teamId, id: { not: signId }, mainPosition: match.captainPosition },
      }))
    )
      throw badRequest('该队已有队长，每队只能有一名指定分路的队长');
  }

  const targetMemberCount = await tx.matchSignup.count({
    where: { teamId, id: { not: signId } },
  });
  if (sign.teamId !== teamId && targetMemberCount >= POSITIONS.length) {
    return { kind: 'team_full' as const };
  }

  if (input.teamPosition && !isPosition(input.teamPosition)) {
    return { kind: 'invalid_position' as const };
  }

  if (match.useFee) {
    const budget =
      typeof input.overrideBudget === 'number' && input.overrideBudget > 0
        ? input.overrideBudget
        : await matchBudget(sign.matchId, tx);
    const teammates = await tx.matchSignup.findMany({
      where: { teamId, id: { not: signId } },
      include: { user: { include: { profile: { select: { rank: true } } } } },
    });
    const used = teammates.reduce((sum, member) => sum + rankFee(signRank(member)), 0);
    const fee = rankFee(signRank(sign));
    if (used + fee > budget) {
      return { kind: 'over_budget' as const, used, budget, fee };
    }
  }

  const teammateOrders = await tx.matchSignup.findMany({
    where: { teamId },
    select: { positionOrder: true },
  });
  const maxOrder = teammateOrders.reduce((max, row) => Math.max(max, row.positionOrder), 0);

  {
    if (input.teamPosition) {
      const occupied = await tx.matchSignup.findFirst({
        where: { teamId, teamPosition: input.teamPosition, id: { not: signId } },
      });
      if (occupied) {
        const vacated = isPosition(sign.teamPosition) ? sign.teamPosition : null;
        await tx.matchSignup.update({
          where: { id: occupied.id },
          data: {
            teamPosition: vacated ?? '',
            positionOrder: vacated ? occupied.positionOrder : 0,
          },
        });
      }
    }
    await tx.matchSignup.update({
      where: { id: signId },
      data: {
        teamId,
        teamPosition: input.teamPosition ?? '',
        positionOrder: maxOrder + 1,
        isCaptain: match.captainPosition
          ? sign.mainPosition === match.captainPosition
          : sign.teamId === teamId
            ? sign.isCaptain
            : targetMemberCount === 0,
        isWaitlisted: false,
        waitlistOrigin: sign.isWaitlisted || sign.waitlistOrigin,
      },
    });
  }

  if (sign.teamId && sign.teamId !== teamId) await ensureTeamCaptain(sign.teamId, tx);
  await ensureTeamCaptain(teamId, tx);

  const draftOrderUpdated =
    wasUnassigned || sign.teamId !== teamId
      ? await reorderDraftAfterCompletedRound(sign.matchId, tx, input.draftTeamIds)
      : false;
  return { kind: 'ok' as const, draftOrderUpdated };
}

/** 队内位置调换（up / down）。 */
export async function moveSignup(signId: number, direction: 'up' | 'down', actorId?: number) {
  const sign = await prisma.matchSignup.findUnique({ where: { id: signId } });
  if (!sign || !sign.teamId) return { kind: 'not_in_team' as const };
  const match = await prisma.match.findUnique({ where: { id: sign.matchId } });
  if (!match) return { kind: 'match_not_found' as const };
  if (await statusStillBlocked(actorId, match.status !== 'CREATED'))
    return { kind: 'match_started' as const };

  const siblings = await prisma.matchSignup.findMany({
    where: { teamId: sign.teamId },
    orderBy: [{ positionOrder: 'asc' }, { id: 'asc' }],
  });
  const index = siblings.findIndex((row) => row.id === signId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= siblings.length) return { kind: 'out_of_range' as const };

  const other = siblings[target];
  await prisma.$transaction([
    prisma.matchSignup.update({
      where: { id: sign.id },
      data: { positionOrder: other.positionOrder },
    }),
    prisma.matchSignup.update({
      where: { id: other.id },
      data: { positionOrder: sign.positionOrder },
    }),
  ]);
  return { kind: 'ok' as const };
}

/** 智能自动分人：只分配正式名额，保留选手分路并尽量平衡各队费用。 */
export async function autoAssign(matchId: number, actorId?: number) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return { kind: 'match_not_found' as const };
  if (await statusStillBlocked(actorId, match.status !== 'CREATED'))
    return { kind: 'match_started' as const };

  const budget = await matchBudget(matchId);
  let assigned = 0;

  for (;;) {
    const { teams, signs, usedFee, memberCount } = await teamUsage(matchId);
    if (!teams.length) break;

    let formalTeamCount = Math.floor(signs.length / POSITIONS.length);
    if (formalTeamCount % 2 === 1) formalTeamCount -= 1;
    const formalSlots = Math.max(0, formalTeamCount) * POSITIONS.length;
    const assignedCount = signs.filter((sign) => sign.teamId !== null).length;
    const remainingFormalSlots = Math.max(0, formalSlots - assignedCount);
    const pool = signs
      .filter((sign) => !sign.teamId)
      .sort((a, b) => a.id - b.id)
      .slice(0, remainingFormalSlots)
      .map((sign) => ({ sign, fee: rankFee(signRank(sign)) }));
    if (!pool.length) break;

    const members = new Map<number, MatchSignup[]>();
    for (const sign of signs) {
      if (!sign.teamId) continue;
      const bucket = members.get(sign.teamId) ?? [];
      bucket.push(sign);
      members.set(sign.teamId, bucket);
    }

    const open = teams
      .map((team) => {
        const occupied = new Set(
          (members.get(team.id) ?? []).map((member) => member.teamPosition).filter(Boolean),
        );
        return {
          team,
          used: usedFee.get(team.id) ?? 0,
          count: memberCount.get(team.id) ?? 0,
          free: POSITIONS.filter((position) => !occupied.has(position)),
        };
      })
      .filter((entry) => entry.count < POSITIONS.length && entry.free.length);
    if (!open.length) break;

    const placements = pool.flatMap(({ sign, fee }) => {
      const preferredPositions = [sign.mainPosition, sign.subPosition].filter(isPosition);
      const options = open.flatMap((entry) => {
        if (
          entry.team.captainSignupId &&
          sign.mainPosition === match.captainPosition &&
          entry.team.captainSignupId !== sign.id
        )
          return [];
        if (match.captainPosition) {
          const isCaptain = sign.mainPosition === match.captainPosition;
          if (!isCaptain && entry.count === 0) return [];
          if (
            isCaptain &&
            (members.get(entry.team.id) ?? []).some(
              (member) => member.mainPosition === match.captainPosition,
            )
          )
            return [];
        }
        const preferredPosition = preferredPositions.find((position) =>
          entry.free.includes(position),
        );
        const position = preferredPosition ?? (sign.canSubstitute ? entry.free[0] : undefined);
        if (!position || fee > budget - entry.used) return [];
        return [
          {
            sign,
            fee,
            team: entry.team,
            used: entry.used,
            count: entry.count,
            position,
            preference: position === sign.mainPosition ? 0 : position === sign.subPosition ? 1 : 2,
          },
        ];
      });
      const bestPreference = Math.min(...options.map((option) => option.preference));
      return options.filter((option) => option.preference === bestPreference);
    });
    if (!placements.length) break;

    const placementsBySign = new Map<number, typeof placements>();
    for (const placement of placements) {
      const options = placementsBySign.get(placement.sign.id) ?? [];
      options.push(placement);
      placementsBySign.set(placement.sign.id, options);
    }
    const candidates = [...placementsBySign.values()];
    candidates.sort(
      (a, b) =>
        a.length - b.length ||
        a[0].preference - b[0].preference ||
        b[0].fee - a[0].fee ||
        a[0].sign.id - b[0].sign.id,
    );
    const chosenTeamPlacements = candidates[0];
    const chosen = chosenTeamPlacements[0];
    const teamFees = teams.map((team) => usedFee.get(team.id) ?? 0);
    const averageFee = teamFees.reduce((sum, fee) => sum + fee, 0) / teams.length;
    chosenTeamPlacements.sort(
      (a, b) =>
        Math.abs(a.used + chosen.fee - averageFee) - Math.abs(b.used + chosen.fee - averageFee) ||
        a.count - b.count ||
        a.team.id - b.team.id,
    );
    const picked = chosenTeamPlacements[0];
    const result = await assignSignup({
      signId: chosen.sign.id,
      teamId: picked.team.id,
      teamPosition: picked.position,
      actorId,
    });
    if (result.kind !== 'ok') throw badRequest('队伍信息发生变化，请重新智能分配');
    assigned += 1;
  }

  return { kind: 'ok' as const, assigned };
}

/** Clear all team assignments while keeping the match teams and signups. */
export async function clearTeamAssignments(matchId: number, actorId?: number) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) return { kind: 'match_not_found' as const };
  if (await statusStillBlocked(actorId, match.status === 'FINISHED'))
    return { kind: 'already_finished' as const };
  const [score, round, record] = await Promise.all([
    prisma.matchScore.findFirst({ where: { matchId }, select: { id: true } }),
    prisma.matchRound.findFirst({ where: { matchId }, select: { id: true } }),
    prisma.matchGameRecord.findFirst({ where: { matchId }, select: { id: true } }),
  ]);
  if (score || round || record) return { kind: 'has_results' as const };

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.match.updateMany({
      where: { id: matchId, status: match.status },
      data: { status: 'CREATED', currentRound: 1, roundEnded: false, feeCardFirstRoundDone: false },
    });
    if (current.count !== 1) return null;
    const signups = await tx.matchSignup.findMany({
      where: { matchId },
      select: { id: true, isWaitlisted: true, waitlistOrigin: true },
    });
    await Promise.all(
      signups.map((signup) =>
        tx.matchSignup.update({
          where: { id: signup.id },
          data: {
            teamId: null,
            teamPosition: '',
            positionOrder: 0,
            isCaptain: false,
            // Never-selected waitlists have no waitlistOrigin; preserve their current status too.
            isWaitlisted: signup.isWaitlisted || signup.waitlistOrigin,
          },
        }),
      ),
    );
    return signups.length;
  });
  if (!result) return { kind: 'not_started' as const };
  return { kind: 'ok' as const, cleared: result };
}
