import { coreAdminRoute, requiredId } from '@/server/api';

import { deleteSeasonTeam } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => deleteSeasonTeam(requiredId(body.teamId)));
