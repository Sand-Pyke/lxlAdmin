import { coreAdminRoute, requiredId } from '@/server/api';

import { finishSeasonMatch } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body, adminId }) =>
  finishSeasonMatch(
    requiredId(body.matchId),
    Number(body.scoreOne),
    Number(body.scoreTwo),
    adminId,
  ),
);
