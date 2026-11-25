import { prisma } from '@/lib/prisma';
import { badRequest } from '@/server/api';
import { applyLedger } from '@/server/points';

/**
 * 商城充值（核心管理员）：给用户充值冠军币，并写入系统通知（通知中心展示到账）。
 */

export async function rechargeUser(userId: number, amount: number, note: string, actorId?: number) {
  if (!Number.isInteger(userId) || userId < 1) throw badRequest('用户参数无效');
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('充值金额需为正整数');

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) throw badRequest('用户不存在');

  const noteText = note.trim();
  const balance = await prisma.$transaction(async (tx) => {
    const after = await applyLedger(
      tx,
      userId,
      amount,
      'ADMIN_RECHARGE',
      'RECHARGE',
      undefined,
      noteText,
    );
    await tx.userNotification.create({
      data: {
        userId,
        type: 'POINT_RECHARGE',
        title: '充值到账',
        content: `管理员为你充值 ${amount} 冠军币${noteText ? `（${noteText}）` : ''}`,
      },
    });
    return after;
  });

  return { user_id: userId, amount, balance, note: noteText };
}
