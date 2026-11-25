import { coreAdminRoute, requiredId } from '@/server/api';

import { assignSeasonMember } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) =>
  assignSeasonMember(requiredId(body.seasonId), body),
);
