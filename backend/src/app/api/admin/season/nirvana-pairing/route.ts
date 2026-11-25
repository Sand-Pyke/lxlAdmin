import { coreAdminRoute, requiredId } from '@/server/api';
import { updateNirvanaSemifinalPairing } from '@/server/season';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => {
  const seasonId = requiredId(body.seasonId);
  const pairs = Array.isArray(body.pairs)
    ? (body.pairs as { matchId?: unknown; teamOneId?: unknown; teamTwoId?: unknown }[]).map(
        (pair) => ({
          matchId: requiredId(pair.matchId),
          teamOneId: requiredId(pair.teamOneId),
          teamTwoId: requiredId(pair.teamTwoId),
        }),
      )
    : [];
  return updateNirvanaSemifinalPairing(seasonId, pairs);
});
