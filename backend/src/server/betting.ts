import { Prisma, type MatchMarket } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { badRequest, forbidden, notFound } from '@/server/api';
import { pairTeams, rankFee, signRank } from '@/server/roster';
import { matchOdds, payoutFor } from '@/server/odds';
import { POOL_ALL_IN_LIMIT, POOL_PRICING, poolQuote, poolVoidReason } from '@/lib/pool-odds';
import { applyLedger, lockWallet } from '@/server/points';
import { boForRound, CUSTOM_FORMAT, gameCountForBo, marketRoundLabel } from '@/lib/admin-options';
import { isLineupReady } from '@/lib/lineup-readiness';
import { resolveMarketCloseAt } from '@/server/market-window';
import {
  lockMarket,
  closeMarketInTransaction,
  settleMarketInTransaction,
  voidMarketInTransaction,
  type OutcomeKey,
} from '@/server/market-settlement';

/**
 * 竞猜盘口核心：开盘（费用→赔率自动生成）、投注（快照赔率）、结算、退款。
 * 数据模型全部用纯 Int 外键（未声明 Prisma relation），查询一律手动 join，避免改动现有大模型。
 */

export type { OutcomeKey } from '@/server/market-settlement';

/** 常规赛的一组对阵（六队/八队淘汰赛里一场赛事含多组对阵，盘口按对阵区分）。 */
export type RegularPairing = { roundNo: number; teamOneId: number; teamTwoId: number };

// ---------- 出场费用 ----------

/**
 * 常规赛当前轮次及之后的对阵：已固化的 MatchRound 优先（结束本轮时会写下一轮对阵），
 * 尚未固化的当前轮按队伍顺序推算（与赛果页/战果录入用的是同一套配对规则）。
 * 批量查询：管理端开盘下拉要一次性列出所有可开盘赛事。
 */
async function regularPairingsByMatch(matchIds: number[]) {
  const result = new Map<number, RegularPairing[]>();
  if (!matchIds.length) return result;

  const [matches, rounds, teams] = await Promise.all([
    prisma.match.findMany({
      where: { id: { in: matchIds } },
      select: {
        id: true,
        currentRound: true,
        teamOneId: true,
        teamTwoId: true,
        status: true,
        bo: true,
        customTeamCount: true,
      },
    }),
    prisma.matchRound.findMany({
      where: { matchId: { in: matchIds } },
      orderBy: [{ roundNo: 'asc' }, { id: 'asc' }],
      select: { matchId: true, roundNo: true, teamOneId: true, teamTwoId: true },
    }),
    prisma.team.findMany({
      where: {
        matchId: { in: matchIds },
        OR: [
          { match: { captainPosition: '' } },
          { captainSignupId: { not: null } },
          { signups: { some: {} } },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        matchId: true,
        signups: {
          select: { teamId: true, teamPosition: true, mainPosition: true, isWaitlisted: true },
        },
      },
    }),
  ]);

  const teamsByMatch = new Map<number, { id: number }[]>();
  for (const team of teams) {
    const bucket = teamsByMatch.get(team.matchId) ?? [];
    bucket.push({ id: team.id });
    teamsByMatch.set(team.matchId, bucket);
  }

  for (const match of matches) {
    const selectedTeams = teams.filter((team) => team.matchId === match.id);
    if (
      !isLineupReady(
        match,
        selectedTeams,
        selectedTeams.flatMap((team) => team.signups),
      )
    ) {
      result.set(match.id, []);
      continue;
    }
    const currentRound = Math.max(match.currentRound || 1, 1);
    const frozen = rounds.filter((row) => row.matchId === match.id && row.roundNo >= currentRound);
    result.set(
      match.id,
      frozen.length
        ? frozen.map(({ roundNo, teamOneId, teamTwoId }) => ({ roundNo, teamOneId, teamTwoId }))
        : pairTeams(match, teamsByMatch.get(match.id) ?? [])
            .filter((pair): pair is [number, number] => pair[1] !== null)
            .map(([teamOneId, teamTwoId]) => ({ roundNo: currentRound, teamOneId, teamTwoId })),
    );
  }
  return result;
}

/** 常规赛某组对阵的出场费用（对阵双方非候补成员的段位费之和）。 */
async function regularTeamFees(matchId: number, teamOneId: number, teamTwoId: number) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, name: true, date: true, bo: true, roundFormats: true },
  });
  if (!match) throw notFound('赛事不存在');

  const teams = await prisma.team.findMany({
    where: { matchId, id: { in: [teamOneId, teamTwoId] } },
    select: { id: true },
  });
  if (teams.length !== 2) throw badRequest('该对阵不属于本场赛事，无法开盘');

  const signups = await prisma.matchSignup.findMany({
    where: {
      matchId,
      isWaitlisted: false,
      teamId: { in: [teamOneId, teamTwoId] },
    },
    include: { user: { include: { profile: { select: { rank: true } } } } },
  });
  const fee = (teamId: number) =>
    signups.filter((s) => s.teamId === teamId).reduce((sum, s) => sum + rankFee(signRank(s)), 0);
  return {
    source: match,
    feeOne: fee(teamOneId),
    feeTwo: fee(teamTwoId),
  };
}

/** 解析要开盘的常规赛对阵：显式传入的必须是本场可开盘的对阵；只有一组时自动选中。 */
async function resolveRegularPairing(
  matchId: number,
  rawTeamOneId: unknown,
  rawTeamTwoId: unknown,
): Promise<RegularPairing> {
  const pairings = (await regularPairingsByMatch([matchId])).get(matchId) ?? [];
  const hasExplicit =
    rawTeamOneId !== undefined &&
    rawTeamOneId !== null &&
    rawTeamTwoId !== undefined &&
    rawTeamTwoId !== null;

  if (hasExplicit) {
    const teamOneId = Number(rawTeamOneId);
    const teamTwoId = Number(rawTeamTwoId);
    if (!Number.isInteger(teamOneId) || !Number.isInteger(teamTwoId))
      throw badRequest('对阵参数无效');
    const pairing = pairings.find(
      (row) =>
        (row.teamOneId === teamOneId && row.teamTwoId === teamTwoId) ||
        (row.teamOneId === teamTwoId && row.teamTwoId === teamOneId),
    );
    if (!pairing) throw badRequest('该对阵不存在或已结束，请刷新后重试');
    return pairing;
  }

  if (!pairings.length) throw badRequest('该赛事还没有确定对阵，无法开盘');
  if (pairings.length > 1) throw badRequest('请选择要开盘的对阵');
  return pairings[0];
}

/** 战队赛两队出场费用：队长+首发，叠加该场替补换人。 */
async function seasonTeamFees(seasonMatchId: number) {
  const match = await prisma.teamSeasonMatch.findUnique({
    where: { id: seasonMatchId },
    select: { id: true, teamOneId: true, teamTwoId: true, scheduledAt: true },
  });
  if (!match) throw notFound('场次不存在');

  const members = await prisma.teamSeasonMember.findMany({
    where: { teamId: { in: [match.teamOneId, match.teamTwoId] } },
    include: { user: { include: { profile: { select: { rank: true } } } } },
  });
  const subs = await prisma.teamSeasonMatchSubstitution.findMany({
    where: { matchId: seasonMatchId },
  });

  const rankOf = new Map(members.map((m) => [m.userId, m.user.profile?.rank ?? '']));
  const fee = (teamId: number) => {
    const starters = members
      .filter((m) => m.teamId === teamId && (m.role === 'CAPTAIN' || m.role === 'STARTER'))
      .map((m) => m.userId);
    const onField = new Set(starters);
    for (const sub of subs.filter((s) => s.teamId === teamId)) {
      onField.delete(sub.starterUserId);
      onField.add(sub.substituteUserId);
    }
    let sum = 0;
    for (const uid of onField) sum += rankFee(rankOf.get(uid));
    return sum;
  };
  return { source: match, feeOne: fee(match.teamOneId), feeTwo: fee(match.teamTwoId) };
}

// ---------- 开盘 ----------

async function teamNamesRegular(teamOneId: number, teamTwoId: number) {
  const [one, two] = await Promise.all([
    prisma.team.findUnique({ where: { id: teamOneId }, select: { name: true, logo: true } }),
    prisma.team.findUnique({ where: { id: teamTwoId }, select: { name: true, logo: true } }),
  ]);
  return {
    one: one?.name ?? '队伍一',
    two: two?.name ?? '队伍二',
    teams: [
      { name: one?.name ?? '队伍一', logo: one?.logo ?? '' },
      { name: two?.name ?? '队伍二', logo: two?.logo ?? '' },
    ],
  };
}

async function teamNamesSeason(teamOneId: number, teamTwoId: number) {
  const [one, two] = await Promise.all([
    prisma.teamSeasonTeam.findUnique({ where: { id: teamOneId }, select: { name: true } }),
    prisma.teamSeasonTeam.findUnique({ where: { id: teamTwoId }, select: { name: true } }),
  ]);
  return { one: one?.name ?? '队伍一', two: two?.name ?? '队伍二' };
}

export async function openMarket(body: Record<string, unknown>) {
  const matchId = body.matchId === undefined ? null : Number(body.matchId);
  const seasonMatchId = body.seasonMatchId === undefined ? null : Number(body.seasonMatchId);
  if ((matchId === null) === (seasonMatchId === null))
    throw badRequest('必须且只能指定 matchId 或 seasonMatchId 之一');

  // 小场局次：不传 = 大场（MATCH_WIN）；传正整数 = 第 N 局（GAME_WIN）。
  let roundNo: number | null = null;
  if (body.roundNo !== undefined && body.roundNo !== null && body.roundNo !== '') {
    roundNo = Number(body.roundNo);
    if (!Number.isInteger(roundNo) || roundNo < 1) throw badRequest('局次需为不小于 1 的整数');
  }

  const returnRate = Number(body.returnRate ?? 0.9);
  const sigma = Number(body.sigma ?? 8);
  if (!(returnRate >= 0.5 && returnRate <= 0.99)) throw badRequest('返还率需在 0.5~0.99 之间');
  if (!(sigma >= 1 && sigma <= 50)) throw badRequest('实力敏感度需在 1~50 之间');

  const marketKind = roundNo !== null ? 'GAME_WIN' : 'MATCH_WIN';

  // 常规赛按「对阵」开盘：六队/八队淘汰赛一场赛事有多组对阵，必须落到具体双方。
  const pairing =
    matchId !== null ? await resolveRegularPairing(matchId, body.teamOneId, body.teamTwoId) : null;

  return prisma.$transaction(async (tx) => {
    // Serialize opening against score entry for this fixture.
    if (matchId !== null) {
      await tx.$queryRaw`SELECT "id" FROM "Match" WHERE "id" = ${matchId} FOR UPDATE`;
      const scored = await tx.matchScore.findFirst({
        where: {
          matchId,
          roundNo: pairing!.roundNo,
          OR: [
            { teamOneId: pairing!.teamOneId, teamTwoId: pairing!.teamTwoId },
            { teamOneId: pairing!.teamTwoId, teamTwoId: pairing!.teamOneId },
          ],
        },
      });
      if (scored) throw badRequest('该对阵已录入比分，不能再开盘');
    } else {
      await tx.$queryRaw`SELECT "id" FROM "TeamSeasonMatch" WHERE "id" = ${seasonMatchId} FOR UPDATE`;
      const scored = await tx.teamSeasonMatch.findUnique({ where: { id: seasonMatchId! } });
      if (scored?.status === 'FINISHED' || (scored && (scored.scoreOne > 0 || scored.scoreTwo > 0)))
        throw badRequest('该场已录入比分，不能再开盘');
    }
    let nameOne: string;
    let nameTwo: string;

    if (matchId !== null && pairing) {
      const names = await teamNamesRegular(pairing.teamOneId, pairing.teamTwoId);
      nameOne = names.one;
      nameTwo = names.two;

      if (roundNo !== null) {
        const source = await tx.match.findUniqueOrThrow({
          where: { id: matchId },
          select: { bo: true, roundFormats: true },
        });
        const bo =
          source.bo === CUSTOM_FORMAT
            ? boForRound(source.bo, pairing.roundNo, source.roundFormats)
            : source.bo;
        const gameCount = gameCountForBo(bo);
        if (gameCount <= 0) throw badRequest('该赛制不支持分小场，请直接开大场盘口');
        if (roundNo > gameCount)
          throw badRequest(`${bo} 最多只有 ${gameCount} 局，局次不能超过 ${gameCount}`);
      }
    } else {
      if (roundNo !== null) throw badRequest('战队赛暂不支持分小场，请直接开大场盘口');
      const source = await tx.teamSeasonMatch.findUniqueOrThrow({
        where: { id: seasonMatchId! },
        select: { teamOneId: true, teamTwoId: true },
      });
      const names = await teamNamesSeason(source.teamOneId, source.teamTwoId);
      nameOne = names.one;
      nameTwo = names.two;
    }

    // 幂等：同一赛事 + 同一对阵 + 同一盘口类型（大场 / 某局小场）只保留一个未结算盘口。
    let existing = await tx.matchMarket.findFirst({
      where:
        matchId !== null && pairing
          ? {
              matchId,
              marketKind,
              roundNo,
              teamOneId: pairing.teamOneId,
              teamTwoId: pairing.teamTwoId,
              OR: [
                { matchRoundNo: pairing.roundNo },
                { matchRoundNo: null, status: { in: ['OPEN', 'CLOSED'] } },
              ],
            }
          : { seasonMatchId: seasonMatchId!, marketKind },
      orderBy: { id: 'desc' },
    });

    if (existing) {
      await lockMarket(tx, existing.id);
      existing = await tx.matchMarket.findUnique({ where: { id: existing.id } });
    }

    if (existing && ['SETTLED', 'VOID'].includes(existing.status))
      throw badRequest('该盘口已结算或作废，不能重新开盘');
    const openedAt = new Date();
    const live = existing?.status === 'OPEN' && existing.bettingCloseAt > openedAt;
    if (existing?.pricingMode === POOL_PRICING) {
      if (!live) throw badRequest('奖池盘口封盘后不能重新开盘');
      return { market_id: existing.id, reused: true };
    }
    const resolvedCloseAt = resolveMarketCloseAt(
      existing && live ? existing.bettingCloseAt : null,
      openedAt.getTime(),
    );
    if (existing && (existing.status === 'OPEN' || existing.status === 'CLOSED')) {
      const { feeOne, feeTwo } =
        matchId !== null && pairing
          ? await regularTeamFees(matchId, pairing.teamOneId, pairing.teamTwoId)
          : await seasonTeamFees(seasonMatchId!);
      const { probA, probB, oddsA, oddsB } = matchOdds(feeOne, feeTwo, returnRate, sigma);
      // 更新已有关盘时间与赔率（若选项未被手动覆盖）；封盘后重新开盘即恢复 OPEN。
      const outcomes = await tx.marketOutcome.findMany({ where: { marketId: existing.id } });
      for (const outcome of outcomes) {
        if (outcome.manualOverride) continue;
        const key = outcome.outcomeKey as OutcomeKey;
        await tx.marketOutcome.update({
          where: { id: outcome.id },
          data: {
            prob: key === 'TEAM_ONE_WIN' ? probA : probB,
            odds: key === 'TEAM_ONE_WIN' ? oddsA : oddsB,
            label: key === 'TEAM_ONE_WIN' ? nameOne : nameTwo,
          },
        });
      }
      await tx.matchMarket.update({
        where: { id: existing.id },
        data: {
          status: 'OPEN',
          returnRate,
          sigma,
          bettingCloseAt: resolvedCloseAt,
          bettingOpenAt: live ? (existing.bettingOpenAt ?? openedAt) : openedAt,
          matchRoundNo: pairing?.roundNo ?? null,
        },
      });
      return { market_id: existing.id, reused: true };
    }

    const market = await tx.matchMarket.create({
      data: {
        marketKind,
        pricingMode: POOL_PRICING,
        matchId,
        seasonMatchId,
        roundNo,
        matchRoundNo: pairing?.roundNo ?? null,
        teamOneId: pairing?.teamOneId ?? null,
        teamTwoId: pairing?.teamTwoId ?? null,
        returnRate,
        sigma,
        maxStake: 200,
        perUserCap: 200,
        bettingOpenAt: openedAt,
        bettingCloseAt: resolvedCloseAt,
      },
    });
    await tx.marketOutcome.createMany({
      data: [
        {
          marketId: market.id,
          outcomeKey: 'TEAM_ONE_WIN',
          label: nameOne,
          prob: 0.5,
          odds: 1,
        },
        {
          marketId: market.id,
          outcomeKey: 'TEAM_TWO_WIN',
          label: nameTwo,
          prob: 0.5,
          odds: 1,
        },
      ],
    });
    return { market_id: market.id, reused: false };
  });
}

// ---------- 投注 ----------

async function isParticipant(
  market: {
    matchId: number | null;
    seasonMatchId: number | null;
    teamOneId?: number | null;
    teamTwoId?: number | null;
  },
  userId: number,
) {
  if (market.matchId) {
    // 常规赛盘口按对阵开盘：只有对阵双方不能投注；没有对阵信息的旧盘口仍按全赛事参赛选手拦截。
    const restrictedTeamIds =
      market.teamOneId && market.teamTwoId ? [market.teamOneId, market.teamTwoId] : null;
    const sign = await prisma.matchSignup.findFirst({
      where: {
        matchId: market.matchId,
        userId,
        teamId: restrictedTeamIds ? { in: restrictedTeamIds } : { not: null },
      },
    });
    return Boolean(sign);
  }
  if (market.seasonMatchId) {
    const sm = await prisma.teamSeasonMatch.findUnique({
      where: { id: market.seasonMatchId },
      select: { teamOneId: true, teamTwoId: true },
    });
    if (!sm) return false;
    const member = await prisma.teamSeasonMember.findFirst({
      where: { teamId: { in: [sm.teamOneId, sm.teamTwoId] }, userId },
    });
    return Boolean(member);
  }
  return false;
}

export async function placeBet(
  userId: number,
  marketId: number,
  outcomeId: number,
  stake: number,
  allIn = false,
) {
  await closeExpiredMarkets();
  return prisma.$transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const market = await tx.matchMarket.findUnique({ where: { id: marketId } });
    if (!market) throw notFound('盘口不存在');
    if (market.status !== 'OPEN') throw badRequest('盘口已关闭，不能投注');
    if (Date.now() >= market.bettingCloseAt.getTime()) throw badRequest('投注已截止');

    const maximum = Math.min(200, market.maxStake, market.perUserCap);
    if (!Number.isSafeInteger(stake) || stake < market.minStake || (!allIn && stake > maximum))
      throw badRequest(
        allIn
          ? `ALL IN 至少需要 ${market.minStake} 冠军币`
          : `普通单注需在 ${market.minStake}~${maximum} 冠军币之间`,
      );

    if (market.pricingMode === POOL_PRICING && allIn && stake > POOL_ALL_IN_LIMIT)
      throw badRequest(`奖池盘口 ALL IN 最多 ${POOL_ALL_IN_LIMIT} 冠军币`);

    if (await isParticipant(market, userId)) throw forbidden('参赛选手不能投注本场比赛');

    // The market lock makes double clicks, retries and concurrent opposite-side
    // submissions share the same once-only check before any wallet debit.
    const previous = await tx.bet.findFirst({ where: { userId, marketId } });
    if (previous) throw badRequest('本盘口只能下注一次，已下注后不能追加或更换队伍');

    const outcome = await tx.marketOutcome.findFirst({ where: { id: outcomeId, marketId } });
    if (!outcome) throw badRequest('投注选项不存在');

    if (allIn) {
      const wallet = await lockWallet(tx, userId);
      if (stake !== wallet.balance)
        throw badRequest('冠军币余额已变化，请刷新余额后重新选择 ALL IN');
    }

    const pooled = market.pricingMode === POOL_PRICING;
    const odds = pooled ? 1 : outcome.odds;
    const potential = payoutFor(stake, odds);
    if (!Number.isSafeInteger(potential) || potential > 2_147_483_647)
      throw badRequest('预计返还金额超出支持范围，请减少下注金额');

    const balance = await applyLedger(tx, userId, -stake, 'BET_STAKE', 'BET', marketId, '');
    const bet = await tx.bet.create({
      data: { userId, marketId, outcomeId, stake, oddsAtBet: odds, potentialPayout: potential },
    });
    return {
      bet_id: bet.id,
      stake,
      odds: pooled ? null : Number(odds.toFixed(2)),
      potential_payout: pooled ? null : potential,
      balance,
    };
  });
}

// ---------- 结算 / 退款 ----------

export async function settleMarket(marketId: number, winnerKey: OutcomeKey) {
  return prisma.$transaction((tx) => settleMarketInTransaction(tx, marketId, winnerKey), {
    timeout: 30000,
  });
}

export async function voidMarket(marketId: number) {
  return prisma.$transaction((tx) => voidMarketInTransaction(tx, marketId), { timeout: 30000 });
}

/** 封盘：把盘口置为 CLOSED，此后不可再投注（已投注单保留，待结算或作废）。 */
export async function closeMarket(marketId: number) {
  return prisma.$transaction(
    async (tx) => {
      await lockMarket(tx, marketId);
      const market = await tx.matchMarket.findUnique({ where: { id: marketId } });
      if (!market) throw notFound('盘口不存在');
      if (market.status === 'SETTLED') throw badRequest('盘口已结算，不能封盘');
      if (market.status === 'VOID') throw badRequest('盘口已作废，不能封盘');
      const result = await closeMarketInTransaction(tx, marketId, undefined, market);
      return {
        market_id: marketId,
        ...result,
        ...(result.voided ? { msg: '奖池未达到结算条件，盘口已作废并退回本金' } : {}),
      };
    },
    { timeout: 30000 },
  );
}

// ---------- 查询 ----------

/** The deadline is enforced on the server even if nobody has the page open. */
export async function closeExpiredMarkets() {
  const now = new Date();
  const expired = { status: 'OPEN' as const, bettingCloseAt: { lte: now } };
  await prisma.matchMarket.updateMany({
    where: { ...expired, pricingMode: { not: POOL_PRICING } },
    data: { status: 'CLOSED' },
  });
  const pools = await prisma.matchMarket.findMany({
    where: { ...expired, pricingMode: POOL_PRICING },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const { id } of pools) {
    await prisma.$transaction((tx) => closeMarketInTransaction(tx, id, now), { timeout: 30000 });
  }
}

async function marketSourceInfo(market: {
  matchId: number | null;
  seasonMatchId: number | null;
  teamOneId?: number | null;
  teamTwoId?: number | null;
}) {
  if (market.matchId) {
    const match = await prisma.match.findUnique({
      where: { id: market.matchId },
      select: { id: true, name: true, status: true, date: true },
    });
    let pair: string | null = null;
    let teams: { name: string; logo: string }[] = [];
    if (market.teamOneId && market.teamTwoId) {
      const names = await teamNamesRegular(market.teamOneId, market.teamTwoId);
      pair = `${names.one} vs ${names.two}`;
      teams = names.teams;
    }
    return {
      kind: 'REGULAR',
      name: match?.name ?? '赛事',
      status: match?.status ?? '',
      date: match?.date?.toISOString() ?? null,
      pair,
      teams,
    };
  }
  const sm = await prisma.teamSeasonMatch.findUnique({
    where: { id: market.seasonMatchId ?? 0 },
    select: {
      id: true,
      scheduledAt: true,
      status: true,
      season: { select: { name: true } },
      teamOne: { select: { name: true, logo: true } },
      teamTwo: { select: { name: true, logo: true } },
    },
  });
  return {
    kind: 'TEAM_LEAGUE',
    name: sm?.season.name ?? '战队赛',
    status: sm?.status ?? '',
    date: sm?.scheduledAt.toISOString() ?? null,
    pair: sm ? `${sm.teamOne.name} vs ${sm.teamTwo.name}` : null,
    teams: sm ? [sm.teamOne, sm.teamTwo] : [],
  };
}

/** Presentation follows stable outcome keys, while odds, bets and settlement IDs stay intact. */
function presentMarketOutcomes<T extends { outcomeKey: string; label: string }>(
  outcomes: T[],
  source: { teams: { name: string; logo: string }[] },
) {
  return outcomes.map((outcome) => {
    const index =
      outcome.outcomeKey === 'TEAM_ONE_WIN' ? 0 : outcome.outcomeKey === 'TEAM_TWO_WIN' ? 1 : -1;
    const team = source.teams[index];
    return team ? { ...outcome, label: team.name } : outcome;
  });
}

async function poolOutcomes<T extends { id: number; odds: number; prob: number }>(
  market: MatchMarket,
  outcomes: T[],
) {
  if (market.pricingMode !== POOL_PRICING) return outcomes;
  const rows = await prisma.bet.groupBy({
    by: ['outcomeId'],
    where: { marketId: market.id },
    _sum: { stake: true },
    _count: { _all: true },
  });
  const pool = new Map(rows.map((row) => [row.outcomeId, row]));
  const total = rows.reduce((sum, row) => sum + (row._sum.stake ?? 0), 0);
  const smallest = Math.min(...outcomes.map((outcome) => pool.get(outcome.id)?._sum.stake ?? 0));
  return outcomes.map((outcome) => {
    const poolStake = pool.get(outcome.id)?._sum.stake ?? 0;
    const poolBetCount = pool.get(outcome.id)?._count._all ?? 0;
    return {
      ...outcome,
      poolStake,
      poolBetCount,
      ...(market.status === 'OPEN'
        ? {
            odds: poolQuote(poolStake, total - poolStake, market.returnRate).odds,
            poolReady: !poolVoidReason(smallest, total - smallest, market.returnRate),
            prob: total ? poolStake / total : 0.5,
          }
        : {}),
    };
  });
}

export async function listMarkets(onlyOpen = false) {
  await closeExpiredMarkets();
  const markets = await prisma.matchMarket.findMany({
    where: onlyOpen ? { status: 'OPEN', bettingCloseAt: { gt: new Date() } } : {},
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
  });
  return presentMarkets(markets);
}

/** 管理端按创建日期筛选并分页，不限制为最近 50 条。 */
export async function listAdminMarkets(query: {
  page: number;
  pageSize: number;
  createdAt?: { gte: Date; lt: Date };
}) {
  await closeExpiredMarkets();
  const where: Prisma.MatchMarketWhereInput = query.createdAt ? { createdAt: query.createdAt } : {};
  const total = await prisma.matchMarket.count({ where });
  const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.pageSize)));
  const markets = await prisma.matchMarket.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * query.pageSize,
    take: query.pageSize,
  });
  return { markets: await presentMarkets(markets), total, page, pageSize: query.pageSize };
}

async function presentMarkets(markets: MatchMarket[]) {
  const result = [];
  for (const market of markets) {
    const outcomes = await prisma.marketOutcome.findMany({ where: { marketId: market.id } });
    const source = await marketSourceInfo(market);
    result.push({
      ...market,
      source,
      outcomes: await poolOutcomes(market, presentMarketOutcomes(outcomes, source)),
    });
  }
  return result;
}

/** 可供开盘的比赛候选：常规赛（含当前轮次可选的对阵）与战队赛（双方已确定）。 */
export async function listOpenableMatches() {
  const [regular, season] = await Promise.all([
    prisma.match.findMany({
      where: { type: 'REGULAR', status: { not: 'FINISHED' } },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: 50,
      select: { id: true, name: true, date: true, status: true, bo: true, roundFormats: true },
    }),
    prisma.teamSeasonMatch.findMany({
      where: { status: { not: 'FINISHED' } },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        scheduledAt: true,
        status: true,
        season: { select: { name: true } },
        teamOne: { select: { name: true } },
        teamTwo: { select: { name: true } },
      },
    }),
  ]);

  const pairingsByMatch = await regularPairingsByMatch(regular.map((m) => m.id));
  const teamIds = [
    ...new Set([...pairingsByMatch.values()].flat().flatMap((p) => [p.teamOneId, p.teamTwoId])),
  ];
  const teams = teamIds.length
    ? await prisma.team.findMany({
        where: { id: { in: teamIds } },
        select: { id: true, name: true },
      })
    : [];
  const teamName = new Map(teams.map((team) => [team.id, team.name]));

  return {
    regular: regular.map((m) => ({
      id: m.id,
      name: m.name,
      date: m.date?.toISOString() ?? null,
      status: m.status,
      bo: m.bo,
      pairings: (pairingsByMatch.get(m.id) ?? []).map((pairing) => ({
        roundNo: pairing.roundNo,
        bo: m.bo === CUSTOM_FORMAT ? boForRound(m.bo, pairing.roundNo, m.roundFormats) : m.bo,
        teamOneId: pairing.teamOneId,
        teamTwoId: pairing.teamTwoId,
        label: `${teamName.get(pairing.teamOneId) ?? '待定'} vs ${teamName.get(pairing.teamTwoId) ?? '待定'}`,
      })),
    })),
    season: season.map((sm) => ({
      id: sm.id,
      name: `${sm.season.name} · ${sm.teamOne.name} vs ${sm.teamTwo.name}`,
      date: sm.scheduledAt.toISOString(),
      status: sm.status,
    })),
  };
}

/** 首页竞猜快捷入口：返回当前有开盘盘口的比赛（常规赛 + 战队赛）与跳转地址。 */
export async function listOpenBetTargets() {
  await closeExpiredMarkets();
  const markets = await prisma.matchMarket.findMany({
    where: { status: 'OPEN', bettingCloseAt: { gt: new Date() } },
    select: { matchId: true, seasonMatchId: true },
  });
  const regularIds = [
    ...new Set(markets.filter((m) => m.matchId != null).map((m) => m.matchId as number)),
  ];
  const seasonIds = [
    ...new Set(
      markets.filter((m) => m.seasonMatchId != null).map((m) => m.seasonMatchId as number),
    ),
  ];

  const [regular, season] = await Promise.all([
    prisma.match.findMany({
      where: { id: { in: regularIds } },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    }),
    prisma.teamSeasonMatch.findMany({
      where: { id: { in: seasonIds } },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        seasonId: true,
        season: { select: { name: true } },
        teamOne: { select: { name: true } },
        teamTwo: { select: { name: true } },
      },
    }),
  ]);

  return [
    ...regular.map((match) => ({
      key: `match-${match.id}`,
      kind: 'regular' as const,
      name: match.name,
      href: `/matches/${match.id}`,
    })),
    ...season.map((sm) => ({
      key: `season-${sm.id}`,
      kind: 'season' as const,
      name: `${sm.season.name} · ${sm.teamOne.name} vs ${sm.teamTwo.name}`,
      href: `/season/${sm.seasonId}/result/${sm.id}`,
    })),
  ];
}

export async function getMarketDetail(marketId: number, userId?: number) {
  await closeExpiredMarkets();
  const market = await prisma.matchMarket.findUnique({ where: { id: marketId } });
  if (!market) throw notFound('盘口不存在');
  const [outcomes, source, myBets] = await Promise.all([
    prisma.marketOutcome.findMany({ where: { marketId } }),
    marketSourceInfo(market),
    userId
      ? prisma.bet.findMany({ where: { userId, marketId }, orderBy: { id: 'desc' } })
      : Promise.resolve([]),
  ]);
  const spent = myBets.filter((b) => b.status === 'OPEN').reduce((sum, b) => sum + b.stake, 0);
  return {
    ...market,
    source,
    outcomes: await poolOutcomes(market, presentMarketOutcomes(outcomes, source)),
    my_staked: spent,
    has_bet: myBets.length > 0,
    is_participant: userId ? await isParticipant(market, userId) : false,
    my_bets: myBets,
  };
}

/** 盘口下注明细（管理端）：双方选项的下注统计 + 总池 + 逐笔投注（含游戏昵称与用户名）。 */
export async function getMarketBets(marketId: number) {
  await closeExpiredMarkets();
  const market = await prisma.matchMarket.findUnique({ where: { id: marketId } });
  if (!market) throw notFound('盘口不存在');

  const [storedOutcomes, bets, source] = await Promise.all([
    prisma.marketOutcome.findMany({ where: { marketId }, orderBy: { id: 'asc' } }),
    prisma.bet.findMany({ where: { marketId }, orderBy: [{ id: 'desc' }], take: 1000 }),
    marketSourceInfo(market),
  ]);
  const outcomes = await poolOutcomes(market, presentMarketOutcomes(storedOutcomes, source));

  const users = await prisma.user.findMany({
    where: { id: { in: bets.map((b) => b.userId) } },
    select: { id: true, username: true, profile: { select: { gameName: true } } },
  });
  const userMap = new Map(users.map((user) => [user.id, user]));
  const outcomeLabelMap = new Map(outcomes.map((o) => [o.id, o.label]));

  const pooled = market.pricingMode === POOL_PRICING;
  const outcomeOdds = new Map(outcomes.map((o) => [o.id, o.odds]));
  const locked = market.status === 'CLOSED' || market.status === 'SETTLED';
  const outcomeStats = outcomes.map((o) => {
    const outcomeBets = bets.filter((b) => b.outcomeId === o.id);
    return {
      ...o,
      totalStake:
        'poolStake' in o ? Number(o.poolStake) : outcomeBets.reduce((sum, b) => sum + b.stake, 0),
      betCount: 'poolBetCount' in o ? Number(o.poolBetCount) : outcomeBets.length,
    };
  });

  const detail = bets.map((b) => ({
    id: b.id,
    userId: b.userId,
    username: userMap.get(b.userId)?.username ?? `用户#${b.userId}`,
    gameName: userMap.get(b.userId)?.profile?.gameName.trim() ?? '',
    outcomeId: b.outcomeId,
    outcomeLabel: outcomeLabelMap.get(b.outcomeId) ?? '',
    stake: b.stake,
    odds_at_bet: Number(b.oddsAtBet.toFixed(2)),
    final_odds:
      pooled && locked && b.status !== 'REFUNDED' ? (outcomeOdds.get(b.outcomeId) ?? null) : null,
    potential_payout: pooled && !locked ? null : b.potentialPayout,
    status: b.status,
    settled_payout: b.settledPayout,
    createdAt: b.createdAt.toISOString(),
  }));

  return {
    market: { ...market, source },
    totalPool: outcomeStats.reduce((sum, outcome) => sum + outcome.totalStake, 0),
    totalBets: outcomeStats.reduce((sum, outcome) => sum + outcome.betCount, 0),
    outcomes: outcomeStats,
    bets: detail,
  };
}

export async function myBets(userId: number, page = 0, pageSize = 20) {
  await closeExpiredMarkets();
  const [bets, total] = await Promise.all([
    prisma.bet.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page * pageSize,
      take: pageSize,
    }),
    prisma.bet.count({ where: { userId } }),
  ]);
  const items = [];
  for (const bet of bets) {
    const market = await prisma.matchMarket.findUnique({ where: { id: bet.marketId } });
    const outcome = await prisma.marketOutcome.findUnique({ where: { id: bet.outcomeId } });
    const source = market ? await marketSourceInfo(market) : null;
    items.push({
      ...bet,
      odds_at_bet: Number(bet.oddsAtBet.toFixed(2)),
      potential_payout:
        market?.pricingMode === POOL_PRICING && market.status === 'OPEN'
          ? null
          : bet.potentialPayout,
      settled_payout: bet.settledPayout,
      final_odds:
        market?.pricingMode === POOL_PRICING &&
        market.status !== 'OPEN' &&
        bet.status !== 'REFUNDED'
          ? (outcome?.odds ?? null)
          : null,
      market: market ? { ...market, source } : null,
      outcome: outcome && source ? presentMarketOutcomes([outcome], source)[0] : outcome,
    });
  }
  return { items, total, hasMore: (page + 1) * pageSize < total };
}
