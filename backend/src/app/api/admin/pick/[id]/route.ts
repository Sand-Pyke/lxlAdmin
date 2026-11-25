import { adminRoute, requiredId } from '@/server/api';
import { getPlayers } from '@/lib/repository';
import { teamsBoard } from '@/server/admin';
import { prisma } from '@/lib/prisma';
import { rankFee } from '@/server/roster';
import { isOffRole } from '@/lib/admin-options';

export const dynamic = 'force-dynamic';

/** 大屏选人专用数据接口；排行榜使用与选手排行榜页面完全相同的排序结果。 */
export const GET = adminRoute<{ id: string }>(async ({ params }) => {
  const id = requiredId(params.id);
  const [board, players, waitlistedSigns] = await Promise.all([
    teamsBoard(id),
    getPlayers(),
    prisma.matchSignup.findMany({
      where: { matchId: id, isWaitlisted: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        user: {
          include: {
            profile: {
              select: {
                rank: true,
                avatar: true,
                mainPosition: true,
                subPosition: true,
                gameName: true,
              },
            },
          },
        },
      },
    }),
  ]);
  const leaderboard = new Map<number, { rank: number; kda: number; recent: string }>(
    players.map(
      (player, index) =>
        [player.id, { rank: index + 1, kda: player.kda, recent: player.recent }] as const,
    ),
  );

  return {
    board,
    signs: [
      ...board.signs.map((sign) => ({
        ...sign,
        is_waitlisted: false,
        leaderboard_rank: leaderboard.get(sign.user_id)?.rank ?? null,
        kda: leaderboard.get(sign.user_id)?.kda ?? 0,
        recent: leaderboard.get(sign.user_id)?.recent ?? '',
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
        leaderboard_rank: leaderboard.get(sign.userId)?.rank ?? null,
        kda: leaderboard.get(sign.userId)?.kda ?? 0,
        recent: leaderboard.get(sign.userId)?.recent ?? '',
      })),
    ],
  };
});
