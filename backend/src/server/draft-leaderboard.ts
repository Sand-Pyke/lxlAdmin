import { getPlayers } from '@/lib/repository';

type Leaderboard = Map<number, { rank: number; kda: number; recent: string }>;

let snapshot: Leaderboard | undefined;
let refreshAt = 0;
let pending: Promise<Leaderboard> | undefined;

/** Rank metrics are shared across matches. Only these metrics may be stale. */
export function draftLeaderboard(wait: boolean): Promise<Leaderboard | undefined> {
  if (Date.now() >= refreshAt && !pending) {
    pending = getPlayers()
      .then((players) => {
        snapshot = new Map(
          players.map(({ id, kda, recent }, index) => [id, { rank: index + 1, kda, recent }]),
        );
        refreshAt = Date.now() + 120_000;
        return snapshot;
      })
      .catch((error) => {
        refreshAt = Date.now() + 30_000;
        throw error;
      })
      .finally(() => {
        pending = undefined;
      });
    // The match can open even if the optional rank metrics are temporarily unavailable.
    void pending.catch((error) => console.warn('Draft leaderboard refresh failed', error?.code));
  }
  return wait && !snapshot && pending ? pending : Promise.resolve(snapshot);
}
