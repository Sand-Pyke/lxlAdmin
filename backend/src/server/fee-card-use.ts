import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { FEE_CARD_EFFECT } from '@/lib/fee-reduction';
import { badRequest, notFound } from '@/server/api';
import { reorderDraftAfterCompletedRound } from '@/server/roster';

export async function feeCardStatus(matchId: number, userId: number) {
  const [match, signup, used, available, firstPicks] = await Promise.all([
    prisma.match.findUnique({ where: { id: matchId } }),
    prisma.matchSignup.findUnique({ where: { userId_matchId: { userId, matchId } } }),
    prisma.matchFeeCardUse.findUnique({ where: { userId_matchId: { userId, matchId } } }),
    prisma.userInventory.count({
      where: {
        userId,
        status: 'UNUSED',
        item: { effectType: FEE_CARD_EFFECT },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }),
    prisma.matchSignup.count({ where: { matchId, teamId: { not: null }, isCaptain: false } }),
  ]);
  if (!match) throw notFound('赛事不存在');
  const captain = Boolean(
    signup &&
    !signup.isWaitlisted &&
    (match.captainPosition ? signup.mainPosition === match.captainPosition : signup.isCaptain),
  );
  return {
    available,
    used: Boolean(used),
    captain,
    open: match.status === 'CREATED' && !match.feeCardFirstRoundDone && firstPicks === 0,
  };
}

export async function useFeeCard(matchId: number, userId: number) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        const match = await tx.match.findUnique({ where: { id: matchId } });
        if (!match) throw notFound('赛事不存在');
        if (match.status !== 'CREATED' || match.feeCardFirstRoundDone)
          throw badRequest('首轮选人已结束，不能再使用降费卡');
        const signup = await tx.matchSignup.findUnique({
          where: { userId_matchId: { userId, matchId } },
        });
        if (
          !signup ||
          signup.isWaitlisted ||
          !(match.captainPosition
            ? signup.mainPosition === match.captainPosition
            : signup.isCaptain)
        )
          throw badRequest('只有已正式报名的本场队长可以使用降费卡');
        if (
          await tx.matchFeeCardUse.findUnique({ where: { userId_matchId: { userId, matchId } } })
        ) {
          throw badRequest('本场赛事已使用降费卡，不能重复使用');
        }
        if (
          await tx.matchSignup.count({
            where: { matchId, teamId: { not: null }, isCaptain: false },
          })
        )
          throw badRequest('首轮选人已经开始，不能再使用降费卡');
        const card = await tx.userInventory.findFirst({
          where: {
            userId,
            status: 'UNUSED',
            item: { effectType: FEE_CARD_EFFECT },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { id: 'asc' },
        });
        if (!card) throw badRequest('没有可使用的降费卡');
        const consumed = await tx.userInventory.updateMany({
          where: { id: card.id, userId, status: 'UNUSED' },
          data: { status: 'USED', usedAt: new Date() },
        });
        if (consumed.count !== 1) throw badRequest('降费卡状态已变化，请刷新后重试');
        await tx.matchFeeCardUse.create({ data: { matchId, userId, inventoryId: card.id } });
        await tx.matchSignup.update({
          where: { id: signup.id },
          data: { feeCardInventoryId: card.id },
        });
        await reorderDraftAfterCompletedRound(matchId, tx);
        return { msg: '降费卡已使用并消耗，取消报名不退卡，仅管理员删除赛事时退回' };
      },
      { isolationLevel: 'Serializable' },
    );
  } catch (error) {
    if (['P2002', 'P2034'].includes((error as { code?: string }).code ?? '')) {
      throw badRequest('赛事或降费卡状态已变化，请刷新后重试');
    }
    throw error;
  }
}

export async function refundMatchFeeCards(tx: Prisma.TransactionClient, matchId: number) {
  await tx.userInventory.updateMany({
    where: { feeCardUse: { matchId } },
    data: { status: 'UNUSED', usedAt: null },
  });
}
