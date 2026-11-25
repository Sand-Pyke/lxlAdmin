import { coreAdminRoute, requiredId } from '@/server/api';

import { advanceSwiss } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => advanceSwiss(requiredId(body.seasonId)));
