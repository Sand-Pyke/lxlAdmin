import { adminRoute, requiredId, assertOk } from '@/server/api';
import { clearTeamAssignments } from '@/server/roster';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async ({ body, adminId }) => {
  const { cleared } = assertOk(await clearTeamAssignments(requiredId(body.matchId), adminId));
  return { msg: `已清空 ${cleared} 名选手的队伍分配`, cleared };
});
