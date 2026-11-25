import { coreAdminRoute, forbidden, requiredId } from '@/server/api';
import { isCoreAdminActor } from '@/server/permissions';
import { swapSeasonMatchSchedule } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body, adminId }) => {
  if (!(await isCoreAdminActor(adminId))) throw forbidden('只有核心管理员可以调整赛程');
  return swapSeasonMatchSchedule(
    requiredId(body.seasonId),
    requiredId(body.sourceMatchId),
    requiredId(body.targetMatchId),
  );
});
