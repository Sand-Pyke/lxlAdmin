import { adminRoute, requiredId, assertOk, badRequest } from '@/server/api';

import { autoAssign, autoAssignDraftRemainder } from '@/server/roster';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async ({ body, adminId }) => {
  const matchId = requiredId(body.matchId);
  if (body.balancedDraft === true) {
    if (!Array.isArray(body.draftTeamIds)) throw badRequest('选人队伍范围无效');
    const { assigned, feeGap } = assertOk(
      await autoAssignDraftRemainder(
        matchId,
        body.draftTeamIds.map((id) => requiredId(id, '选人队伍参数无效')),
      ),
    );
    return { assigned, msg: `智能分配完成，补齐 ${assigned} 人，各队总费用最大差 ${feeGap} 分` };
  }
  const { assigned } = assertOk(await autoAssign(matchId, adminId));
  return {
    msg: `智能分配完成，共分配 ${assigned} 名正式选手（优先按主/副位置入队并平衡费用）`,
    assigned,
  };
});
