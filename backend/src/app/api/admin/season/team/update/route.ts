import { coreAdminRoute, requiredId } from '@/server/api';

import { updateSeasonTeam } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) =>
  updateSeasonTeam(requiredId(body.teamId), body),
);
