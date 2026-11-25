import {
  EIGHT_TEAM_FORMAT,
  EIGHT_TEAM_FORMAT_V2,
  SIX_TEAM_FORMAT,
  SIX_TEAM_FORMAT_V2,
} from './admin-options';

export const LINEUP_PENDING_MESSAGE = '队伍编排尚未完成，全部队伍编排完成后开放对阵';

export function isLineupReady(
  match: { status: string; bo: string },
  teams: readonly { id: number }[],
  signups: readonly {
    teamId: number | null;
    teamPosition: string;
    mainPosition: string;
    isWaitlisted: boolean;
  }[],
) {
  // Historical fixtures remain viewable even if their signup roster was later changed.
  if (match.status !== 'CREATED') return true;
  const expected =
    match.bo === 'BO5'
      ? 2
      : match.bo === 'BO3'
        ? 4
        : [SIX_TEAM_FORMAT, SIX_TEAM_FORMAT_V2].includes(match.bo)
          ? 6
          : [EIGHT_TEAM_FORMAT, EIGHT_TEAM_FORMAT_V2].includes(match.bo)
            ? 8
            : null;
  if (expected ? teams.length !== expected : teams.length < 2 || teams.length % 2 !== 0)
    return false;
  const positions = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'];
  return teams.every((team) => {
    const members = signups.filter((signup) => signup.teamId === team.id && !signup.isWaitlisted);
    const occupied = new Set(members.map((member) => member.teamPosition || member.mainPosition));
    return members.length === 5 && positions.every((position) => occupied.has(position));
  });
}
