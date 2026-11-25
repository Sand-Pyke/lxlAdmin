/** 降费只用于首轮选人排序，队伍预算始终使用真实段位费用。 */
export const FEE_CARD_EFFECT = 'FEE_REDUCTION_CARD';
export const FEE_CARD_CODE = 'fee_reduction_card';
export const FEE_CARD_PURCHASE_CAP = 5;

export const RANK_FEES: Record<string, number> = {
  黑铁: 1,
  青铜: 1,
  白银: 1,
  黄金: 1,
  铂金: 2,
  翡翠: 3,
  钻石: 4,
  '钻石+': 5,
  大师: 6,
  '大师+': 7,
  宗师: 8,
  王者: 9,
};

const RANK_FOR_FEE = ['', '黄金', '铂金', '翡翠', '钻石', '钻石+', '大师', '大师+', '宗师', '王者'];

export function reducedDraftRank(rank: string) {
  const original = RANK_FEES[rank] ?? 0;
  const fee = Math.max(1, original - 3);
  return { fee, rank: original <= 1 ? rank : RANK_FOR_FEE[fee] };
}

export function feeCardDisplay(
  rank: string,
  inventoryId: number | null,
  firstRoundActive: boolean,
) {
  const reduced = reducedDraftRank(rank);
  return {
    fee_card_used: inventoryId !== null,
    draft_rank: inventoryId !== null && firstRoundActive ? reduced.rank : rank,
    draft_fee: inventoryId !== null && firstRoundActive ? reduced.fee : (RANK_FEES[rank] ?? 0),
    fee_card_active: inventoryId !== null && firstRoundActive,
  };
}
