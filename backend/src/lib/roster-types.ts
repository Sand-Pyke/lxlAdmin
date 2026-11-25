export type RosterPlayer = {
  id: number;
  name: string;
  /** 游戏名称（名称#编号），如 向阳而生#32250 */
  gameName: string;
  /** 当前佩戴/生效的称号文本；空串表示无称号。 */
  title: string;
  /** 报名位置；未报名的选手名单中为个人主位置。 */
  position: string;
  /** 个人资料中的主位置，独立于报名和组队位置。 */
  profileMainPosition?: string;
  /** 个人资料中的副位置，不能使用报名记录里的副位置替代。 */
  profileSubPosition?: string;
  /** 报名/组队后的位置槽（TOP/JUG/MID/ADC/SUP） */
  teamPosition: string;
  rank: string;
  avatar: string;
  avatarFrame: string;
  nameplate?: string;
  isWaitlisted: boolean;
  isCaptain?: boolean;
  fee_card_active?: boolean;
  draft_rank?: string;
};
