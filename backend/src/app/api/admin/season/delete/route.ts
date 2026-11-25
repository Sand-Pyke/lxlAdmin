import { coreAdminRoute, requiredId } from '@/server/api';

import { deleteSeason } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => deleteSeason(requiredId(body.seasonId)));
