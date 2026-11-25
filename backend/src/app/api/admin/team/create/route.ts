import { adminRoute, requiredId, unwrap } from '@/server/api';

import { createTeam } from '@/server/roster';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async ({ body, adminId }) =>
  unwrap(
    await createTeam(requiredId(body.matchId), String(body.name ?? ''), adminId),
    '队伍创建成功',
  ),
);
