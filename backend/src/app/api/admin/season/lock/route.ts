import { coreAdminRoute, requiredId } from '@/server/api';

import { lockSeasonRoster } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => lockSeasonRoster(requiredId(body.seasonId)));
