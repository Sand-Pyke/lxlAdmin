import { coreAdminRoute } from '@/server/api';
import { voidMarket } from '@/server/betting';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ params }) => {
  return voidMarket(Number(params.id));
});
