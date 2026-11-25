import { coreAdminRoute, requiredId } from '@/server/api';

import { startSwiss } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => startSwiss(requiredId(body.seasonId)));
