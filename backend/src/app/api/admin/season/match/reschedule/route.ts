import { coreAdminRoute, forbidden, requiredId } from '@/server/api';
import { isCoreAdminActor } from '@/server/permissions';
import { updateSeasonMatchSchedule } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body, adminId }) => {
  if (!(await isCoreAdminActor(adminId))) throw forbidden('只有核心管理员可以修改赛程时间');
  return updateSeasonMatchSchedule(requiredId(body.matchId), body.scheduledAt);
});
