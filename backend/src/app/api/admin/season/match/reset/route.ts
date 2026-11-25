import { coreAdminRoute, requiredId } from '@/server/api';
import { resetSeasonMatch } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => resetSeasonMatch(requiredId(body.matchId)));
