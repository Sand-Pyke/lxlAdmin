import { coreAdminRoute, requiredId } from '@/server/api';

import { startNirvanaPlayoffs } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) =>
  startNirvanaPlayoffs(requiredId(body.seasonId)),
);
