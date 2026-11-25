import { coreAdminRoute } from '@/server/api';
import { settleMarket } from '@/server/betting';
import type { OutcomeKey } from '@/server/betting';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ params, body }) => {
  return settleMarket(Number(params.id), body.winnerKey as OutcomeKey);
});
