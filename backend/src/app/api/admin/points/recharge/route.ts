import { coreAdminRoute } from '@/server/api';
import { rechargeUser } from '@/server/recharge';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ adminId, body }) => {
  const userId = Number(body.userId);
  const amount = Number(body.amount);
  const note = String(body.note ?? '');
  return rechargeUser(userId, amount, note, adminId);
});
