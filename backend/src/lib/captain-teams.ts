import { TEAMS_BY_LEAGUE } from './teams';

export type CurrentMatchTeam = {
  id: number;
  name: string;
  logo: string;
  captainUserId: number;
  captainName: string;
};

export const CUSTOM_TEAM_LOGOS = [
  ['armada', '无敌舰队'],
  ['wolf', '极地战狼'],
  ['dragon', '赤龙之翼'],
  ['falcon', '逐风猎隼'],
  ['tiger', '雷牙猛虎'],
  ['kraken', '深海巨妖'],
  ['blade', '破晓锋刃'],
  ['comet', '陨星先锋'],
].map(([key, name]) => ({ name, logo: `/assets/team/custom/${key}.svg` }));

export const CAPTAIN_TEAM_PRESETS = TEAMS_BY_LEAGUE.flatMap(({ teams }) => teams);
export const CAPTAIN_TEAM_LOGOS = [...CAPTAIN_TEAM_PRESETS, ...CUSTOM_TEAM_LOGOS];
export const MAX_TEAM_LOGO_BYTES = 2 * 1024 * 1024;
export function validateCaptainTeam(name: string, logo: string) {
  if (!name.trim() || name.trim().length > 20) return '队名须为 1–20 个字符';
  if (!logo) return '请选择或上传队标';
  return '';
}
export function isPresetTeamLogo(logo: string) {
  return CAPTAIN_TEAM_LOGOS.some((item) => item.logo === logo);
}
