import { coreAdminRoute, requiredId } from '@/server/api';

import { removeSeasonMember } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) =>
  removeSeasonMember(requiredId(body.seasonId), body),
);
