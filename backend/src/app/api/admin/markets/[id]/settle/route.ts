import { coreAdminRoute } from '@/server/api';
import { settleMarket } from '@/server/betting';
import type { OutcomeKey } from '@/server/betting';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ params, body }) => {
  const result = await settleMarket(Number(params.id), body.winnerKey as OutcomeKey);
  return 'voided' in result && result.voided
    ? { ...result, msg: '盘口已作废，未结算胜负派彩' }
    : result;
});
