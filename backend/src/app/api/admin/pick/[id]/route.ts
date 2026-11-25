import { adminRoute, requiredId } from '@/server/api';
import { loadTeamsBoard } from '@/server/admin';
import { draftLeaderboard } from '@/server/draft-leaderboard';
import { rankFee } from '@/server/roster';
import { isOffRole } from '@/lib/admin-options';

export const dynamic = 'force-dynamic';

/** 大屏选人专用数据接口；排行榜使用与选手排行榜页面完全相同的排序结果。 */
export const GET = adminRoute<{ id: string }>(async ({ params, query }) => {
  const id = requiredId(params.id);
  const { board, waitlistedSigns } = await loadTeamsBoard(id);
  const leaderboard = await draftLeaderboard(query.get('live') !== '1');

  return {
    board,
    leaderboard_ready: Boolean(leaderboard),
    signs: [
      ...board.signs.map((sign) => ({
        ...sign,
        is_waitlisted: false,
        leaderboard_rank: leaderboard?.get(sign.user_id)?.rank ?? null,
        kda: leaderboard?.get(sign.user_id)?.kda ?? 0,
        recent: leaderboard?.get(sign.user_id)?.recent ?? '',
      })),
      ...waitlistedSigns.map((sign) => ({
        id: sign.id,
        user_id: sign.userId,
        username: sign.user.username,
        yy_name: sign.displayName,
        game_name: sign.user.profile?.gameName ?? '',
        avatar: sign.user.profile?.avatar ?? '',
        rank: sign.user.profile?.rank || sign.rankAtSignup || '',
        main_pos: sign.mainPosition,
        sub_pos: sign.subPosition,
        is_off_role: isOffRole(
          sign.mainPosition,
          sign.user.profile?.mainPosition,
          sign.user.profile?.subPosition,
        ),
        team_id: null,
        team_pos: '',
        fee: rankFee(sign.user.profile?.rank || sign.rankAtSignup),
        is_waitlisted: true,
        leaderboard_rank: leaderboard?.get(sign.userId)?.rank ?? null,
        kda: leaderboard?.get(sign.userId)?.kda ?? 0,
        recent: leaderboard?.get(sign.userId)?.recent ?? '',
      })),
    ],
  };
});
