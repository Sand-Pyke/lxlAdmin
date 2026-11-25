import { coreAdminRoute, forbidden, requiredId } from '@/server/api';
import { isCoreAdminActor } from '@/server/permissions';
import { realignSeasonSchedule } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body, adminId }) => {
  if (!(await isCoreAdminActor(adminId))) throw forbidden('只有核心管理员可以修正赛程时间');
  return realignSeasonSchedule(requiredId(body.seasonId));
});
