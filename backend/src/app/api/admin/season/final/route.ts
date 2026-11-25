import { coreAdminRoute, requiredId } from '@/server/api';

import { startFinal } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => startFinal(requiredId(body.seasonId)));
