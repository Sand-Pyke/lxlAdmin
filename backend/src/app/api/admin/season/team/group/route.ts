import { coreAdminRoute, requiredId } from '@/server/api';

import { setSeasonTeamDivision } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) =>
  setSeasonTeamDivision(requiredId(body.teamId), body.division),
);
