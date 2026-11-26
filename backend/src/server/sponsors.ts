import { prisma } from '@/lib/prisma';
import { badRequest, notFound } from '@/server/api';

/**
 * 赞助榜。
 *
 * 只有核心管理员（isCoreAdmin）能向赞助名单添加/修改/移除选手，名单从选手库
 * （PlayerProfile）中挑选；普通用户只能读取展示数据。
 */

const profileSelect = {
  userId: true,
  name: true,
  gameName: true,
  avatar: true,
  rank: true,
  mainPosition: true,
} as const;

/** 按赞助金额从高到低，金额相同时先加入的排前面。 */
export async function listSponsors(includePrivate = false) {
  const sponsors = await prisma.sponsor.findMany({
    orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const userIds = sponsors.map((sponsor) => sponsor.userId);
  const profiles = userIds.length
    ? await prisma.playerProfile.findMany({
        where: { userId: { in: userIds } },
        select: profileSelect,
      })
    : [];

  const profileByUser = new Map(profiles.map((profile) => [profile.userId, profile]));
  // 选手资料被清理时兜底过滤，避免展示出「幽灵赞助人」。
  return sponsors
    .filter((sponsor) => profileByUser.has(sponsor.userId))
    .map((sponsor) => {
      const profile = profileByUser.get(sponsor.userId)!;
      if (sponsor.isAnonymous && !includePrivate) {
        return {
          id: sponsor.id,
          amount: Number(sponsor.amount),
          name: '匿名用户',
          isAnonymous: true,
        };
      }
      return {
        id: sponsor.id,
        userId: sponsor.userId,
        amount: Number(sponsor.amount),
        isAnonymous: sponsor.isAnonymous,
        name: profile.name,
        gameName: profile.gameName,
        avatar: profile.avatar,
        rank: profile.rank,
        position: profile.mainPosition,
      };
    });
}

function parseAmount(raw: unknown) {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('赞助金额需大于 0');
  // 金额保留两位小数：多出的位数四舍五入到分，避免浮点误差。
  return Math.round(amount * 100) / 100;
}

function parseUserId(raw: unknown) {
  const userId = Number(raw);
  if (!Number.isInteger(userId) || userId < 1) throw badRequest('请选择赞助选手');
  return userId;
}

function parseAnonymous(raw: unknown) {
  if (raw !== undefined && typeof raw !== 'boolean') throw badRequest('匿名设置无效');
  return raw;
}

/** 核心管理员：从选手库添加一名赞助人。 */
export async function adminAddSponsor(body: Record<string, unknown>) {
  const userId = parseUserId(body.userId);
  const profile = await prisma.playerProfile.findUnique({
    where: { userId },
    select: { userId: true },
  });
  if (!profile) throw badRequest('该选手不在选手库中');
  if (await prisma.sponsor.findUnique({ where: { userId } })) {
    throw badRequest('该选手已在赞助名单中');
  }
  const sponsor = await prisma.sponsor.create({
    data: {
      userId,
      amount: parseAmount(body.amount),
      isAnonymous: parseAnonymous(body.isAnonymous),
    },
  });
  return { id: sponsor.id };
}

/** 核心管理员：修改赞助金额或公开显示设置。 */
export async function adminUpdateSponsor(id: number, body: Record<string, unknown>) {
  const amount = body.amount === undefined ? undefined : parseAmount(body.amount);
  const isAnonymous = parseAnonymous(body.isAnonymous);
  if (amount === undefined && isAnonymous === undefined) throw badRequest('请填写要修改的内容');
  const sponsor = await prisma.sponsor.findUnique({ where: { id }, select: { id: true } });
  if (!sponsor) throw notFound('赞助记录不存在');
  await prisma.sponsor.update({ where: { id }, data: { amount, isAnonymous } });
  return { id };
}

/** 核心管理员：将选手移出赞助名单。 */
export async function adminRemoveSponsor(id: number) {
  const sponsor = await prisma.sponsor.findUnique({ where: { id }, select: { id: true } });
  if (!sponsor) throw notFound('赞助记录不存在');
  await prisma.sponsor.delete({ where: { id } });
  return { id };
}
