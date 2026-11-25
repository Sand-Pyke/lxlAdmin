import { adminRoute, requiredId } from '@/server/api';

import { getSeasonBoard } from '@/server/season';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async ({ params }) => getSeasonBoard(requiredId(params.id)));
