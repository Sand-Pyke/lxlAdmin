import { coreAdminRoute, requiredId } from '@/server/api';

import { startPlayoffs } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => startPlayoffs(requiredId(body.seasonId)));
