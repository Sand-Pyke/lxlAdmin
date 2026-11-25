import { coreAdminRoute } from '@/server/api';
import { getMarketBets } from '@/server/betting';

export const dynamic = 'force-dynamic';

export const GET = coreAdminRoute(async ({ params }) => {
  return getMarketBets(Number(params.id));
});
