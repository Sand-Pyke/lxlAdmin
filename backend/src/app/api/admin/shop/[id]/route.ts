import { coreAdminRoute } from '@/server/api';
import { adminDeleteShopItem, adminUpdateShopItem } from '@/server/shop';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ params, body }) => {
  return adminUpdateShopItem(Number(params.id), body);
});

export const DELETE = coreAdminRoute(async ({ params }) => {
  return adminDeleteShopItem(Number(params.id));
});
