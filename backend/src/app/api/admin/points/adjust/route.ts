import { prisma } from '@/lib/prisma';
import { coreAdminRoute, badRequest } from '@/server/api';
import { applyLedger } from '@/server/points';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => {
  const userId = Number(body.userId);
  const amount = Number(body.amount);
  const note = String(body.note ?? '');
  if (!Number.isInteger(userId) || userId < 1) throw badRequest('用户参数无效');
  if (!Number.isInteger(amount) || amount === 0) throw badRequest('调整金额需为非零整数');

  const balance = await prisma.$transaction((tx) =>
    applyLedger(tx, userId, amount, 'ADMIN_ADJUST', 'ADMIN', undefined, note),
  );
  return { user_id: userId, balance };
});
