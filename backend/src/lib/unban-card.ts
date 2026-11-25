/** 解禁卡按固定时长抵扣封禁，前后端共用展示规则。 */
export const UNBAN_CARD_DAYS = 3;
export const UNBAN_CARD_REDUCTION_MS = UNBAN_CARD_DAYS * 24 * 60 * 60 * 1000;
export const UNBAN_CARD_DESCRIPTION =
  '每张抵扣3天（72小时）报名封禁，剩余不足3天时直接解除；未被封禁时不会消耗。每次限购1张，已有未使用的有效解禁卡时不能重复购买，使用后可再购买。';
