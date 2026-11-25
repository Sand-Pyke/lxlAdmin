import type { RosterPlayer } from '@/lib/roster-types';

export type MatchRegistrationSnapshot = {
  matchId: number;
  status: 'CREATED' | 'LIVE' | 'FINISHED';
  playerCount: number;
  players: (RosterPlayer & { declaration: string })[];
};
