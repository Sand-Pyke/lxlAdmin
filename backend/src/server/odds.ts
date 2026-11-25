/**
 * 赔率核心：费用（段位费）→ 实力 → 胜率 → 欧赔。
 * 赔率不直接等于费用，而是先把费用差折算成胜率，再按返还率换算成十进制欧赔。
 */

/** logistic 胜率：feeA vs feeB，sigma 为实力敏感度（越大差距影响越小）。 */
export function logisticProbability(feeA: number, feeB: number, sigma = 8) {
  return 1 / (1 + Math.exp((feeB - feeA) / sigma));
}

/** 十进制欧赔 = 返还率 / 胜率，并裁剪到 [min, max]。 */
export function decimalOdds(prob: number, returnRate: number, min = 1.05, max = 20) {
  if (!(prob > 0)) return max;
  const odds = returnRate / prob;
  return Math.max(min, Math.min(max, odds));
}

/** 由两队出场费用生成赔率：返回双方胜率与赔率（两位小数展示由调用方处理）。 */
export function matchOdds(feeA: number, feeB: number, returnRate = 0.9, sigma = 8) {
  const probA = logisticProbability(feeA, feeB, sigma);
  const probB = 1 - probA;
  return {
    probA,
    probB,
    oddsA: decimalOdds(probA, returnRate),
    oddsB: decimalOdds(probB, returnRate),
  };
}

/** 中奖派彩（含本金）：stake × 赔率，四舍五入到整数冠军币。 */
export function payoutFor(stake: number, odds: number) {
  return Math.max(0, Math.round(stake * odds));
}
