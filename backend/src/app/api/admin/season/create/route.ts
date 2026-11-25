import { coreAdminRoute } from '@/server/api';

import { createSeason } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => createSeason(body));
