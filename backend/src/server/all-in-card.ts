import { prisma } from '@/lib/prisma';
import {
  ALL_IN_CARD_EFFECT,
  allInDayBounds,
  allInReward,
  isAllInMatchToday,
} from '@/lib/all-in-card';
import { badRequest, notFound } from '@/server/api';
import { applyLedger } from '@/server/points';

export async function settleAllInCards(matchId: number) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
      const match = await tx.match.findUnique({ where: { id: matchId } });
      if (!match || match.status !== 'FINISHED' || !match.championTeamId) return { settled: 0 };
      const uses = await tx.matchAllInCardUse.findMany({
        where: { matchId, status: 'PENDING' },
        orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      });
      for (const use of uses) {
        const won = use.teamId === match.championTeamId;
        const payout = won ? use.reward : 0;
        if (payout)
          await applyLedger(
            tx,
            use.userId,
            payout,
            'ALL_IN_CARD_REWARD',
            'ALL_IN_CARD',
            use.id,
            `${match.name} · ${use.teamName}夺冠 · 原价${use.reward / 3}币 × 3（实付${use.purchasePrice}币）`,
          );
        await tx.matchAllInCardUse.update({
          where: { id: use.id },
          data: { status: won ? 'WON' : 'LOST', payout, settledAt: new Date() },
        });
        await tx.userNotification.create({
          data: {
            userId: use.userId,
            type: 'PRIZE_GRANT',
            title: won ? '梭哈成功' : '梭哈卡已结算',
            content: won
              ? `「${match.name}」你绑定的「${use.teamName}」夺冠，已返还 ${payout} 冠军币。`
              : `「${match.name}」你绑定的「${use.teamName}」未夺冠，本次梭哈不返还冠军币。`,
          },
        });
      }
      return { settled: uses.length };
    },
    { timeout: 30_000 },
  );
}

/** 失败重试入口：只处理该用户已结束赛事中的未结算凭证。 */
export async function settlePendingAllInCards(userId: number) {
  const uses = await prisma.matchAllInCardUse.findMany({
    where: {
      userId,
      status: 'PENDING',
      match: { status: 'FINISHED', championTeamId: { not: null } },
    },
    select: { matchId: true },
  });
  for (const matchId of new Set(uses.map((use) => use.matchId))) await settleAllInCards(matchId);
}

export async function allInCardOptions(userId: number, inventoryId?: number, matchId?: number) {
  await settlePendingAllInCards(userId);
  const { start, end } = allInDayBounds();
  const [cards, signs, uses] = await Promise.all([
    prisma.userInventory.findMany({
      where: {
        userId,
        ...(inventoryId ? { id: inventoryId } : {}),
        status: 'UNUSED',
        item: { effectType: ALL_IN_CARD_EFFECT },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.matchSignup.findMany({
      where: {
        userId,
        isWaitlisted: false,
        teamId: { not: null },
        ...(matchId ? { matchId } : {}),
        match: {
          status: 'CREATED',
          type: 'REGULAR',
          OR: [
            { date: { gte: start, lt: end } },
            { date: null, createdAt: { gte: start, lt: end } },
          ],
        },
      },
      include: { match: true, team: true },
    }),
    prisma.matchAllInCardUse.findMany({ where: { userId, ...(matchId ? { matchId } : {}) } }),
  ]);
  const orders = await prisma.shopOrder.findMany({
    where: {
      userId,
      id: { in: cards.flatMap((card) => (card.orderId ? [card.orderId] : [])) },
      status: 'SUCCESS',
    },
  });
  const available = cards.flatMap((card) => {
    const order = orders.find((order) => order.id === card.orderId && order.itemId === card.itemId);
    if (!order) return [];
    try {
      const originalPrice = order.originalPrice ?? order.price;
      return [
        { id: card.id, price: order.price, originalPrice, reward: allInReward(originalPrice) },
      ];
    } catch {
      return [];
    }
  });
  return {
    cards: available,
    matches: signs
      .filter((sign) => sign.team && !uses.some((use) => use.matchId === sign.matchId))
      .map((sign) => ({ id: sign.matchId, name: sign.match.name, teamName: sign.team!.name })),
    used: matchId ? (uses.find((use) => use.matchId === matchId) ?? null) : null,
  };
}

export async function useAllInCard(userId: number, inventoryId: number, matchId: number) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const match = await tx.match.findUnique({ where: { id: matchId } });
      if (!match) throw notFound('赛事不存在');
      if (match.type !== 'REGULAR' || match.status !== 'CREATED' || !isAllInMatchToday(match))
        throw badRequest('仅可在当天常规赛开赛前使用梭哈卡');
      const signup = await tx.matchSignup.findUnique({
        where: { userId_matchId: { userId, matchId } },
        include: { team: true },
      });
      if (
        !signup ||
        signup.isWaitlisted ||
        !signup.teamId ||
        !signup.team ||
        signup.team.matchId !== matchId
      )
        throw badRequest('请先加入本场赛事的正式队伍');
      if (await tx.matchAllInCardUse.findUnique({ where: { userId_matchId: { userId, matchId } } }))
        throw badRequest('每人每场赛事只能使用1张梭哈卡');
      const card = await tx.userInventory.findUnique({
        where: { id: inventoryId },
        include: { item: true },
      });
      if (
        !card ||
        card.userId !== userId ||
        card.status !== 'UNUSED' ||
        card.item.effectType !== ALL_IN_CARD_EFFECT ||
        (card.expiresAt && card.expiresAt <= new Date())
      )
        throw badRequest('梭哈卡不存在、已使用或已过期');
      const order = card.orderId
        ? await tx.shopOrder.findUnique({ where: { id: card.orderId } })
        : null;
      if (
        !order ||
        order.userId !== userId ||
        order.itemId !== card.itemId ||
        order.status !== 'SUCCESS'
      )
        throw badRequest('找不到有效购卡订单，不能使用此梭哈卡');
      let reward: number;
      try {
        reward = allInReward(order.originalPrice ?? order.price);
      } catch {
        throw badRequest('梭哈卡原价无效');
      }
      const consumed = await tx.userInventory.updateMany({
        where: {
          id: inventoryId,
          userId,
          status: 'UNUSED',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { status: 'USED', usedAt: new Date() },
      });
      if (consumed.count !== 1) throw badRequest('梭哈卡状态已变化，请刷新后重试');
      const use = await tx.matchAllInCardUse.create({
        data: {
          matchId,
          userId,
          inventoryId,
          teamId: signup.teamId,
          teamName: signup.team.name,
          purchasePrice: order.price,
          reward,
        },
      });
      return {
        ok: true,
        reward: use.reward,
        teamName: use.teamName,
        msg: `梭哈卡已使用，绑定「${use.teamName}」，夺冠后返还 ${use.reward} 冠军币`,
      };
    });
  } catch (error) {
    if (['P2002', 'P2034'].includes((error as { code?: string }).code ?? ''))
      throw badRequest('本场已使用梭哈卡或状态已变化，请刷新后重试');
    throw error;
  }
}
