import { adminRoute } from '@/server/api';

import { listSeasons } from '@/server/season';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => listSeasons());
