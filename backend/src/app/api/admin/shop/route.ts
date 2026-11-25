import { coreAdminRoute } from '@/server/api';
import { adminListShopItems } from '@/server/shop';

export const dynamic = 'force-dynamic';

export const GET = coreAdminRoute(async () => {
  const items = await adminListShopItems();
  return { items };
});
