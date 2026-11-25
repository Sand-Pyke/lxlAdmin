import { coreAdminRoute, requiredId } from '@/server/api';

import { createSeasonTeam } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) =>
  createSeasonTeam(requiredId(body.seasonId), body),
);
