import { coreAdminRoute, requiredId } from '@/server/api';
import { updateSeasonMatchSubstitutions } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) =>
  updateSeasonMatchSubstitutions(requiredId(body.matchId), body),
);
