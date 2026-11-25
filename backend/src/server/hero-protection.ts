import { Prisma } from '@prisma/client';
import { canonicalChampionName, championAsset } from '@/lib/game-assets';
import { prisma } from '@/lib/prisma';
import { ApiError, badRequest, notFound } from '@/server/api';

export type HeroProtectionAwardType = 'FMVP' | 'CHAMPION';

export function heroCardAwardLabel(awardType: string) {
  if (awardType === 'FMVP') return '赛事 FMVP';
  if (awardType === 'CHAMPION') return '夺冠奖励';
  if (awardType === 'SHOP') return '商城购买';
  return '夺冠奖励';
}

export function awardHeroProtectionCard(
  tx: Prisma.TransactionClient,
  ownerId: number,
  sourceMatchId: number,
  awardType: HeroProtectionAwardType,
) {
  return tx.heroProtectionCard.upsert({
    where: {
      ownerId_sourceMatchId_awardType: { ownerId, sourceMatchId, awardType },
    },
    create: { ownerId, sourceMatchId, awardType },
    update: {},
  });
}

export async function consumeMatchHeroProtections(tx: Prisma.TransactionClient, matchId: number) {
  const match = await tx.match.findUniqueOrThrow({
    where: { id: matchId },
    select: { currentRound: true },
  });
  const protections = await tx.matchHeroProtection.findMany({
    where: { matchId, roundNo: match.currentRound || 1, card: { consumedAt: null } },
    select: { ownerId: true, teamId: true, cardId: true },
  });
  for (const protection of protections) {
    const stillAssigned = await tx.matchSignup.findFirst({
      where: {
        matchId,
        userId: protection.ownerId,
        teamId: protection.teamId,
        isWaitlisted: false,
      },
      select: { id: true },
    });
    if (!stillAssigned) {
      await tx.matchHeroProtection.delete({ where: { cardId: protection.cardId } });
      continue;
    }
    const consumed = await tx.heroProtectionCard.updateMany({
      where: { id: protection.cardId, ownerId: protection.ownerId, consumedAt: null },
      data: { consumedAt: new Date(), usedMatchId: matchId },
    });
    if (consumed.count !== 1) throw badRequest('启用中的免 ban 卡已不可用，请检查后重新开赛');
  }
}

export async function getHeroCardPack(ownerId: number) {
  const cards = await prisma.heroProtectionCard.findMany({
    where: { ownerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      awardType: true,
      createdAt: true,
      consumedAt: true,
      sourceMatch: { select: { name: true } },
      usedMatch: { select: { name: true } },
      protection: { select: { roundNo: true, match: { select: { name: true } } } },
    },
  });
  return {
    available_count: cards.filter((card) => !card.consumedAt && !card.protection).length,
    cards: cards.map((card) => ({
      id: card.id,
      award_type: card.awardType,
      award_label: heroCardAwardLabel(card.awardType),
      source_match: card.sourceMatch?.name ?? '来源赛事',
      created_at: card.createdAt.toISOString(),
      status: card.consumedAt ? 'USED' : card.protection ? 'RESERVED' : 'AVAILABLE',
      reserved_match: card.protection
        ? `${card.protection.match.name} · 第 ${card.protection.roundNo} 轮`
        : '',
      used_match: card.usedMatch
        ? `${card.usedMatch.name}${card.protection ? ` · 第 ${card.protection.roundNo} 轮` : ''}`
        : '',
    })),
  };
}

async function teamInRound(
  db: Prisma.TransactionClient,
  matchId: number,
  roundNo: number,
  teamId: number,
) {
  const pairs = await db.matchRound.findMany({
    where: { matchId, roundNo },
    select: { teamOneId: true, teamTwoId: true },
  });
  return pairs.length
    ? pairs.some((p) => p.teamOneId === teamId || p.teamTwoId === teamId)
    : roundNo === 1;
}

async function lockCurrentRound(tx: Prisma.TransactionClient, matchId: number, roundNo: number) {
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
  const match = await tx.match.findUnique({
    where: { id: matchId },
    select: { status: true, currentRound: true },
  });
  if (!match) throw notFound('赛事不存在');
  if (!['CREATED', 'LIVE'].includes(match.status))
    throw badRequest('赛事已结束，不能使用免 ban 卡');
  if (match.currentRound !== roundNo)
    throw new ApiError(409, '赛事轮次已变化，请刷新后重新选择本轮免 ban 卡');
  return match;
}

export async function getMatchHeroProtection(matchId: number, ownerId: number) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, name: true, status: true, currentRound: true },
  });
  if (!match) throw notFound('赛事不存在');

  const signup = await prisma.matchSignup.findFirst({
    where: { matchId, userId: ownerId, teamId: { not: null }, isWaitlisted: false },
    select: { teamId: true, team: { select: { name: true } } },
  });
  const teamProtection = signup?.teamId
    ? await prisma.matchHeroProtection.findUnique({
        where: {
          matchId_roundNo_teamId: { matchId, roundNo: match.currentRound, teamId: signup.teamId },
        },
        select: {
          id: true,
          ownerId: true,
          heroName: true,
          cardId: true,
          card: { select: { consumedAt: true } },
          owner: {
            select: { profile: { select: { gameName: true, name: true } }, username: true },
          },
        },
      })
    : null;
  const cards = await prisma.heroProtectionCard.findMany({
    where: {
      ownerId,
      consumedAt: null,
      OR: [
        { protection: null },
        { protection: { matchId, roundNo: match.currentRound, teamId: signup?.teamId ?? -1 } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, awardType: true },
  });

  return {
    match_status: match.status,
    current_round: match.currentRound,
    eligible: Boolean(
      signup?.teamId &&
      ['CREATED', 'LIVE'].includes(match.status) &&
      (await teamInRound(prisma, matchId, match.currentRound, signup.teamId)),
    ),
    team_name: signup?.team?.name ?? '',
    available_cards: cards.map((card) => ({
      id: card.id,
      award_label: heroCardAwardLabel(card.awardType),
    })),
    team_protection: teamProtection
      ? {
          hero_name: teamProtection.heroName,
          owner_id: teamProtection.ownerId,
          owner_name:
            teamProtection.owner.profile?.gameName ||
            teamProtection.owner.profile?.name ||
            teamProtection.owner.username,
          is_mine: teamProtection.ownerId === ownerId,
          card_id: teamProtection.cardId,
          consumed: Boolean(teamProtection.card.consumedAt),
        }
      : null,
  };
}

export async function setMatchHeroProtection(
  matchId: number,
  ownerId: number,
  cardId: number,
  heroInput: string,
  roundNo: number,
) {
  const heroName = canonicalChampionName(heroInput);
  if (!championAsset(heroName)) throw badRequest('请选择有效的英雄');

  try {
    await prisma.$transaction(async (tx) => {
      await lockCurrentRound(tx, matchId, roundNo);

      const signup = await tx.matchSignup.findFirst({
        where: { matchId, userId: ownerId, teamId: { not: null }, isWaitlisted: false },
        select: { teamId: true },
      });
      if (!signup?.teamId) throw badRequest('只有已编入队伍的参赛选手才能使用免 ban 卡');

      if (!(await teamInRound(tx, matchId, roundNo, signup.teamId)))
        throw badRequest('本队未参加当前轮次，不能使用免 ban 卡');
      const existing = await tx.matchHeroProtection.findUnique({
        where: { matchId_roundNo_teamId: { matchId, roundNo, teamId: signup.teamId } },
        select: {
          id: true,
          ownerId: true,
          cardId: true,
          heroName: true,
          card: { select: { consumedAt: true } },
        },
      });
      if (existing && existing.ownerId !== ownerId)
        throw badRequest('本队本轮已使用免 ban 卡，每队每轮只能保护一个英雄');
      if (existing?.card.consumedAt) {
        if (existing.cardId === cardId && existing.heroName === heroName) return;
        throw badRequest('本队本轮免 ban 卡已消耗，不能更换卡片或保护英雄');
      }

      const card = await tx.heroProtectionCard.findFirst({
        where: {
          id: cardId,
          ownerId,
          consumedAt: null,
          OR: [{ protection: null }, { protection: { id: existing?.id ?? -1 } }],
        },
        select: { id: true },
      });
      if (!card) throw badRequest('这张卡不可用或不属于你');

      const consumed = await tx.heroProtectionCard.updateMany({
        where: { id: cardId, ownerId, consumedAt: null },
        data: { consumedAt: new Date(), usedMatchId: matchId },
      });
      if (consumed.count !== 1) throw badRequest('这张免 ban 卡已经被使用，请刷新后重试');

      if (existing) {
        await tx.matchHeroProtection.update({
          where: { id: existing.id },
          data: { cardId, heroName },
        });
      } else {
        await tx.matchHeroProtection.create({
          data: { matchId, roundNo, teamId: signup.teamId, ownerId, cardId, heroName },
        });
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw badRequest('该卡片已使用或本队本轮已有保护，请刷新后重试');
    throw error;
  }

  return { msg: `第 ${roundNo} 轮免 ban 已生效，卡片已消耗` };
}

export async function removeMatchHeroProtection(matchId: number, ownerId: number, roundNo: number) {
  await prisma.$transaction(async (tx) => {
    await lockCurrentRound(tx, matchId, roundNo);
    const used = await tx.matchHeroProtection.findFirst({
      where: { matchId, roundNo, ownerId, card: { consumedAt: { not: null } } },
    });
    if (used) throw badRequest('本轮免 ban 卡已消耗，不能取消或退回');

    const removed = await tx.matchHeroProtection.deleteMany({
      where: { matchId, roundNo, ownerId, card: { consumedAt: null } },
    });
    if (!removed.count) throw badRequest('没有可取消的免 ban 卡');
  });
  return { msg: '免 ban 卡已取消，可继续在其他赛事使用' };
}
