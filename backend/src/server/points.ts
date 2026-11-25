import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { badRequest } from '@/server/api';

/**
 * 冠军币钱包与流水核心。
 * 余额一律通过流水表记账（双记账），balance = 流水求和，可对账。
 */

export type LedgerType =
  | 'SIGNUP_BONUS'
  | 'DAILY_CHECKIN'
  | 'BET_STAKE'
  | 'BET_WIN'
  | 'BET_REFUND'
  | 'SHOP_SPEND'
  | 'ADMIN_ADJUST'
  | 'ADMIN_RECHARGE'
  | 'PRIZE_GRANT'
  | 'ALL_IN_CARD_REWARD';

/**
 * 确保钱包存在（并发安全：并发下也只会创建一条）。
 *
 * 这里不能用 upsert：Prisma 对「空的 update」无法生成 `INSERT ... ON CONFLICT DO UPDATE`，
 * 会退化成「先查后插」，两个请求同时进来就会撞 userId 唯一约束抛 P2002。
 * createMany + skipDuplicates 编译成 `INSERT ... ON CONFLICT DO NOTHING`，天然幂等。
 */
export async function ensureWallet(tx: Prisma.TransactionClient, userId: number) {
  const existing = await tx.pointWallet.findUnique({ where: { userId } });
  if (existing) return existing;
  await tx.pointWallet.createMany({ data: [{ userId }], skipDuplicates: true });
  return tx.pointWallet.findUniqueOrThrow({ where: { userId } });
}

/** 先锁定再读取余额，让下注、商城消费和派彩使用同一份最新余额。 */
export async function lockWallet(tx: Prisma.TransactionClient, userId: number) {
  await ensureWallet(tx, userId);
  const [wallet] = await tx.$queryRaw<{ balance: number }[]>`
    SELECT "balance" FROM "PointWallet" WHERE "userId" = ${userId} FOR UPDATE
  `;
  if (!wallet) throw badRequest('冠军币钱包不存在');
  return wallet;
}

/**
 * 在事务内变动余额并写流水。amount 可正可负。
 * 返回变动后的余额。
 */
export async function applyLedger(
  tx: Prisma.TransactionClient,
  userId: number,
  amount: number,
  type: LedgerType,
  refType = '',
  refId?: number,
  note = '',
) {
  if (!Number.isInteger(amount)) throw badRequest('冠军币变动必须为整数');
  const wallet = await lockWallet(tx, userId);
  if (amount < 0 && wallet.balance + amount < 0) throw badRequest('冠军币余额不足');

  const updated = await tx.pointWallet.update({
    where: { userId },
    data: {
      balance: { increment: amount },
      ...(amount > 0 ? { totalEarned: { increment: amount } } : {}),
      ...(amount < 0 ? { totalSpent: { increment: -amount } } : {}),
    },
  });
  await tx.pointTransaction.create({
    data: {
      userId,
      amount,
      type,
      refType,
      refId,
      balanceAfter: updated.balance,
      note,
    },
  });
  return updated.balance;
}

/** 读取钱包（不存在则建，返回余额）。 */
export async function getWallet(userId: number) {
  const wallet = await prisma.pointWallet.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  return wallet;
}

/** 查询用户流水（分页）。 */
export async function listTransactions(userId: number, page = 0, pageSize = 20) {
  const [items, total] = await Promise.all([
    prisma.pointTransaction.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page * pageSize,
      take: pageSize,
    }),
    prisma.pointTransaction.count({ where: { userId } }),
  ]);
  return { items, total, hasMore: (page + 1) * pageSize < total };
}
