/**
 * 数据层的公共类型。
 *
 * 选手的对局统计（胜场 / KDA / MVP / 积分）一律由 MatchGameRecord 现算得出，
 * 不在选手资料表里冗余存储，因此这里的字段是聚合结果而非数据库列。
 */
export type WealthRankingEntry = {
  id: number;
  gameName: string;
  avatar: string;
  avatarFrame: string;
  title: string;
  rank: string;
  balance: number;
};

export type Player = {
  id: number;
  name: string;
  username: string;
  gameName: string;
  /** 当前佩戴/生效的称号文本；空串表示无称号。 */
  title: string;
  /** 主位置（历史字段名，等价于 mainPosition） */
  position: string;
  mainPosition: string;
  subPosition: string;
  rank: string;
  bio: string;
  avatar: string;
  /** 当前佩戴的头像框 effect.value（如 "gold"）；空串表示未佩戴。 */
  avatarFrame: string;
  kookName: string;
  background: string;
  wins: number;
  losses: number;
  games: number;
  winRate: number;
  kda: number;
  mvp: number;
  svp: number;
  fmvp: number;
  points: number;
  teamChampion: number;
  runnerup: number;
  mvpRate: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  /** 最常用英雄 */
  hero: string;
  /**
   * 选手在「我的资料」里自选的常用英雄（最多 3 个，顺序即填写顺序）。
   * 选手中心与个人主页优先展示这一份；为空时回退到战绩统计出的 hero。
   */
  favoriteHeroes: string[];
  /** 最近 10 场胜负序列，如 "W L W W" */
  recent: string;
};

export type Match = {
  id: number;
  name: string;
  /** 创建时间与管理员账号名，仅赛事管理列表展示。 */
  createdAt?: string;
  createdByName?: string;
  /** 排期时间（可选）：未设置时为 null，展示为「时间待定」。 */
  date: string | null;
  status: 'CREATED' | 'LIVE' | 'FINISHED';
  /** 基础信息中的状态是否已经手动修改过。 */
  statusLocked?: boolean;
  bo: string;
  playerCount: number;
  teamCount: number;
  signed?: boolean;
  round: string;
  /** 直播链接（仅 LIVE 状态可设置） */
  liveUrl: string;
  /** 是否启用选手费用预算 */
  useFee: boolean;
  captainPosition: string;
  currentRound: number;
  /** 是否为 LCU 自动导入的目标赛事（管理员在后台指定）。 */
  importTarget: boolean;
  teamOneId: number | null;
  teamTwoId: number | null;
  /** 冠军池配置 JSON（名次档 → 每人冠军币）。 */
  prizePoolJson: string;
  /** 冠军池是否已发放。 */
  prizeDistributed: boolean;
  /** 「我的比赛」列表：我的队伍名（如「T1」）。 */
  myTeamName?: string;
  /** 「我的比赛」列表：我的名次标签（如「四强」「亚军」「冠军」）。 */
  myPlacement?: string;
};

/** 首页「最近赛果」：一场赛事最新一轮的对阵比分。 */
export type RecentResult = {
  id: number;
  name: string;
  status: 'CREATED' | 'LIVE' | 'FINISHED';
  round_no: number;
  pairs: Array<{
    team1: string;
    team2: string;
    score: [number, number];
  }>;
};
