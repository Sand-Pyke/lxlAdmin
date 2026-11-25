import { coreAdminRoute } from '@/server/api';
import { adminCreateShopItem } from '@/server/shop';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => {
  return adminCreateShopItem(body);
});
