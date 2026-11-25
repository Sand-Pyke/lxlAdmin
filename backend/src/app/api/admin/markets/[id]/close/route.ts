import { coreAdminRoute } from '@/server/api';
import { closeMarket } from '@/server/betting';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ params }) => {
  return closeMarket(Number(params.id));
});
