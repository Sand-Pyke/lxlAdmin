import { adminRoute, requiredId, assertOk, badRequest } from '@/server/api';

import { endRound } from '@/server/roster';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ id: string }>(async ({ params, body, adminId }) => {
  const wildcardTeamId =
    body.wildcardTeamId === undefined || body.wildcardTeamId === null || body.wildcardTeamId === ''
      ? undefined
      : requiredId(body.wildcardTeamId);
  const expectedRoundNo = body.roundNo === undefined ? undefined : requiredId(body.roundNo);
  const result = await endRound(requiredId(params.id), wildcardTeamId, adminId, expectedRoundNo);
  if (result.kind === 'stale_round') throw badRequest('赛事已进入其他轮次，请核对最新对阵');
  if (result.kind === 'wildcard_required') throw badRequest('请选择一支首轮失利队伍晋级四强');
  if (result.kind === 'invalid_wildcard') throw badRequest('晋级队伍必须来自首轮失利队伍');
  const outcome = assertOk(result);
  if (outcome.finished) {
    return {
      msg: `决赛结束，第${outcome.roundNo}轮战果已固化，赛事圆满收官！`,
      roundNo: outcome.roundNo,
      finished: true,
    };
  }
  return {
    msg: `第${outcome.roundNo}轮已结束，胜者已晋级第${outcome.roundNo + 1}轮`,
    roundNo: outcome.roundNo,
    finished: false,
  };
});
