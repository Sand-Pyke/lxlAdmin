import { coreAdminRoute, requiredId } from '@/server/api';

import { autoGroupSeasonTeams } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) =>
  autoGroupSeasonTeams(requiredId(body.seasonId)),
);
