import type { Prisma } from '@prisma/client';
import { badRequest, notFound } from '@/server/api';
import { creditLedger } from '@/server/points';
import { marketRoundLabel } from '@/lib/admin-options';
export type OutcomeKey = 'TEAM_ONE_WIN' | 'TEAM_TWO_WIN';
const OUTCOME_KEYS: OutcomeKey[] = ['TEAM_ONE_WIN', 'TEAM_TWO_WIN'];

/** Serialize bets, settlement and refunds on the same market. */
export async function lockMarket(tx: Prisma.TransactionClient, marketId: number) {
  await tx.$queryRaw`SELECT "id" FROM "MatchMarket" WHERE "id" = ${marketId} FOR UPDATE`;
}

export async function settleMarketInTransaction(
  tx: Prisma.TransactionClient,
  marketId: number,
  winnerKey: OutcomeKey,
) {
  if (!OUTCOME_KEYS.includes(winnerKey)) throw badRequest('胜方参数无效');

  await lockMarket(tx, marketId);
  const market = await tx.matchMarket.findUnique({ where: { id: marketId } });
  if (!market) throw notFound('盘口不存在');
  if (market.status === 'SETTLED') return { settled: 0, already_settled: true };
  if (market.status === 'VOID') throw badRequest('盘口已作废，不能结算');

  const outcomes = await tx.marketOutcome.findMany({ where: { marketId } });
  const winner = outcomes.find((o) => o.outcomeKey === winnerKey);
  if (!winner) throw badRequest('胜方选项不存在');

  const bets = await tx.bet.findMany({
    where: { marketId, status: 'OPEN' },
    orderBy: [{ userId: 'asc' }, { id: 'asc' }],
  });
  const settledAt = new Date();
  const winners = bets.filter((bet) => bet.outcomeId === winner.id);
  if (bets.length) {
    // The market lock also guards placement of new bets.
    await tx.$executeRaw`
      UPDATE "Bet"
      SET status = CASE WHEN "outcomeId" = ${winner.id} THEN 'WON'::"BetStatus" ELSE 'LOST'::"BetStatus" END,
          "settledPayout" = CASE WHEN "outcomeId" = ${winner.id} THEN "potentialPayout" ELSE "settledPayout" END,
          "settledAt" = ${settledAt}
      WHERE "marketId" = ${marketId} AND status = 'OPEN'
    `;
    await creditLedger(
      tx,
      winners.map((bet) => ({ userId: bet.userId, amount: bet.potentialPayout })),
      'BET_WIN',
      'BET',
      marketId,
    );
  }
  await tx.matchMarket.update({
    where: { id: marketId },
    data: { status: 'SETTLED', settledAt },
  });
  if (!bets.length) return { settled: 0, total_stake: 0, total_payout: 0, pnl: 0 };

  // 结算后给每位投注用户发通知：中奖则告知派彩与净赚，未中奖则告知亏损本金。
  const totalStake = bets.reduce((sum, b) => sum + b.stake, 0);
  const totalPayout = winners.reduce((sum, b) => sum + b.potentialPayout, 0);
  const pnl = totalStake - totalPayout;

  let sourceName = '赛事';
  if (market.matchId) {
    const match = await tx.match.findUnique({
      where: { id: market.matchId },
      select: { name: true },
    });
    sourceName = match?.name ?? '赛事';
    if (market.teamOneId && market.teamTwoId) {
      const [one, two] = await Promise.all([
        tx.team.findUnique({ where: { id: market.teamOneId } }),
        tx.team.findUnique({ where: { id: market.teamTwoId } }),
      ]);
      const names = { one: one?.name ?? '队伍一', two: two?.name ?? '队伍二' };
      sourceName = `${sourceName} · ${names.one} vs ${names.two}`;
    }
  } else if (market.seasonMatchId) {
    const sm = await tx.teamSeasonMatch.findUnique({
      where: { id: market.seasonMatchId },
      select: {
        season: { select: { name: true } },
        teamOne: { select: { name: true } },
        teamTwo: { select: { name: true } },
      },
    });
    sourceName = sm ? `${sm.season.name} · ${sm.teamOne.name} vs ${sm.teamTwo.name}` : '战队赛';
  }

  const outcomeLabelMap = new Map(outcomes.map((o) => [o.id, o.label]));
  const roundText = marketRoundLabel(market.marketKind, market.roundNo);
  await tx.userNotification.createMany({
    data: bets.map((bet) => {
      const won = bet.outcomeId === winner.id;
      const label = outcomeLabelMap.get(bet.outcomeId) ?? '';
      const net = won ? bet.potentialPayout - bet.stake : -bet.stake;
      return {
        userId: bet.userId,
        type: 'BET_RESULT',
        title: won ? '竞猜中奖' : '竞猜未中奖',
        content: won
          ? `「${sourceName}」${roundText}盘口已结算：你押「${label}」中奖，投注 ${bet.stake} 冠军币，派彩 ${bet.potentialPayout} 冠军币，净赚 ${net} 冠军币`
          : `「${sourceName}」${roundText}盘口已结算：你押「${label}」未中奖，投注 ${bet.stake} 冠军币，亏损 ${-net} 冠军币`,
      };
    }),
  });

  return { settled: bets.length, total_stake: totalStake, total_payout: totalPayout, pnl };
}

export async function voidMarketInTransaction(tx: Prisma.TransactionClient, marketId: number) {
  await lockMarket(tx, marketId);
  const market = await tx.matchMarket.findUnique({ where: { id: marketId } });
  if (!market) throw notFound('盘口不存在');
  if (market.status === 'SETTLED') throw badRequest('盘口已结算，不能作废');
  if (market.status === 'VOID') return { refunded: 0 };

  const bets = await tx.bet.findMany({
    where: { marketId, status: 'OPEN' },
    orderBy: [{ userId: 'asc' }, { id: 'asc' }],
  });
  const settledAt = new Date();
  if (bets.length) {
    await tx.$executeRaw`
      UPDATE "Bet"
      SET status = 'REFUNDED', "settledPayout" = stake, "settledAt" = ${settledAt}
      WHERE "marketId" = ${marketId} AND status = 'OPEN'
    `;
    await creditLedger(
      tx,
      bets.map((bet) => ({ userId: bet.userId, amount: bet.stake })),
      'BET_REFUND',
      'BET',
      marketId,
    );
  }
  await tx.matchMarket.update({
    where: { id: marketId },
    data: { status: 'VOID', settledAt },
  });
  return { refunded: bets.length };
}

type RegularScore = {
  matchId: number;
  roundNo: number;
  teamOneId: number;
  teamTwoId: number;
  scoreOne: number;
  scoreTwo: number;
};

/** Require a complete, consistent ten-player game before using its winner. */
async function gameWinner(
  tx: Prisma.TransactionClient,
  market: {
    matchId: number | null;
    matchRoundNo: number | null;
    roundNo: number | null;
    teamOneId: number | null;
    teamTwoId: number | null;
  },
  tournamentRound: number,
): Promise<number | null> {
  if (!market.matchId || !market.roundNo || !market.teamOneId || !market.teamTwoId) return null;
  const signs = await tx.matchSignup.findMany({
    where: { matchId: market.matchId, teamId: { in: [market.teamOneId, market.teamTwoId] } },
  });
  const teams = new Map(signs.map((s) => [s.userId, s.teamId]));
  const records = await tx.matchGameRecord.findMany({
    where: {
      matchId: market.matchId,
      roundNo: tournamentRound,
      gameNo: market.roundNo,
      userId: { in: signs.map((s) => s.userId) },
    },
  });
  const one = records.filter((r) => (r.teamId ?? teams.get(r.userId)) === market.teamOneId);
  const two = records.filter((r) => (r.teamId ?? teams.get(r.userId)) === market.teamTwoId);
  if (one.length !== 5 || two.length !== 5 || new Set(records.map((r) => r.userId)).size !== 10)
    return null;
  if (one.every((r) => r.result === 'win') && two.every((r) => r.result === 'lose'))
    return market.teamOneId;
  if (two.every((r) => r.result === 'win') && one.every((r) => r.result === 'lose'))
    return market.teamTwoId;
  return null;
}

/** Score and payout share one transaction: a failed payout cannot be silently lost. */
export async function settleMarketsForRegularScore(
  tx: Prisma.TransactionClient,
  score: RegularScore,
) {
  const current = await tx.match.findUnique({
    where: { id: score.matchId },
    select: { currentRound: true },
  });
  const markets = await tx.matchMarket.findMany({
    where: {
      matchId: score.matchId,
      status: { in: ['OPEN', 'CLOSED'] },
      AND: [
        {
          OR: [
            { teamOneId: score.teamOneId, teamTwoId: score.teamTwoId },
            { teamOneId: score.teamTwoId, teamTwoId: score.teamOneId },
          ],
        },
        {
          OR: [
            { matchRoundNo: score.roundNo },
            ...(current?.currentRound === score.roundNo ? [{ matchRoundNo: null }] : []),
          ],
        },
      ],
    },
    orderBy: { id: 'asc' },
  });
  const winner =
    score.scoreOne === score.scoreTwo
      ? null
      : score.scoreOne > score.scoreTwo
        ? score.teamOneId
        : score.teamTwoId;
  for (const market of markets) {
    if (market.marketKind === 'MATCH_WIN') {
      if (winner === null) await voidMarketInTransaction(tx, market.id);
      else
        await settleMarketInTransaction(
          tx,
          market.id,
          winner === market.teamOneId ? 'TEAM_ONE_WIN' : 'TEAM_TWO_WIN',
        );
    } else if (market.marketKind === 'GAME_WIN' && market.roundNo) {
      if (market.roundNo > score.scoreOne + score.scoreTwo) {
        await voidMarketInTransaction(tx, market.id);
        continue;
      }
      // A sweep determines every played game. Mixed series need individual records.
      const gameTeam =
        score.scoreOne === 0 || score.scoreTwo === 0
          ? winner
          : await gameWinner(tx, market, score.roundNo);
      if (gameTeam !== null)
        await settleMarketInTransaction(
          tx,
          market.id,
          gameTeam === market.teamOneId ? 'TEAM_ONE_WIN' : 'TEAM_TWO_WIN',
        );
      else
        await tx.matchMarket.updateMany({
          where: { id: market.id, status: 'OPEN' },
          data: { status: 'CLOSED', bettingCloseAt: new Date() },
        });
    }
  }
}

export async function settleGameMarketsForMatch(tx: Prisma.TransactionClient, matchId: number) {
  const match = await tx.match.findUnique({
    where: { id: matchId },
    select: { currentRound: true },
  });
  const markets = await tx.matchMarket.findMany({
    where: { matchId, marketKind: 'GAME_WIN', status: { in: ['OPEN', 'CLOSED'] } },
    orderBy: { id: 'asc' },
  });
  for (const market of markets) {
    const winner = await gameWinner(tx, market, market.matchRoundNo ?? match?.currentRound ?? 1);
    if (winner !== null)
      await settleMarketInTransaction(
        tx,
        market.id,
        winner === market.teamOneId ? 'TEAM_ONE_WIN' : 'TEAM_TWO_WIN',
      );
  }
}

export async function settleMarketsForSeasonScore(
  tx: Prisma.TransactionClient,
  seasonMatchId: number,
  scoreOne: number,
  scoreTwo: number,
) {
  const markets = await tx.matchMarket.findMany({
    where: { seasonMatchId, marketKind: 'MATCH_WIN', status: { in: ['OPEN', 'CLOSED'] } },
    orderBy: { id: 'asc' },
  });
  for (const market of markets) {
    if (scoreOne === scoreTwo) await voidMarketInTransaction(tx, market.id);
    else
      await settleMarketInTransaction(
        tx,
        market.id,
        scoreOne > scoreTwo ? 'TEAM_ONE_WIN' : 'TEAM_TWO_WIN',
      );
  }
}
