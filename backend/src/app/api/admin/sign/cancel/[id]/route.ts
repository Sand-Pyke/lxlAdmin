import { adminRoute, forbidden, requiredId } from '@/server/api';
import { isCoreAdminActor } from '@/server/permissions';

import { cancelSignup } from '@/server/admin';
import { cancelSeasonSignup } from '@/server/season';

export const dynamic = 'force-dynamic';

// type=season 时取消的是战队赛报名（TeamSeasonSignup），默认是常规赛报名。
// 战队赛写操作仅核心管理员可执行，普通管理员只读。
export const POST = adminRoute<{ id: string }>(async ({ params, query, adminId }) => {
  const season = query.get('type') === 'season';
  if (season && !(await isCoreAdminActor(adminId))) {
    throw forbidden('只有核心管理员可以管理战队赛');
  }
  return season
    ? cancelSeasonSignup(requiredId(params.id), adminId)
    : cancelSignup(requiredId(params.id), adminId);
});
