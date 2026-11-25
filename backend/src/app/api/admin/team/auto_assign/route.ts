import { adminRoute, requiredId, assertOk } from '@/server/api';

import { autoAssign } from '@/server/roster';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async ({ body, adminId }) => {
  const { assigned } = assertOk(await autoAssign(requiredId(body.matchId), adminId));
  return {
    msg: `智能分配完成，共分配 ${assigned} 名正式选手（优先按主/副位置入队并平衡费用）`,
    assigned,
  };
});
