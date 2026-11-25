import { coreAdminRoute } from '@/server/api';
import { openMarket } from '@/server/betting';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => {
  return openMarket(body);
});
