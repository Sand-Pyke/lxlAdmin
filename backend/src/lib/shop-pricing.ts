const DISCOUNT_RANKS = new Set(['大师+', '宗师', '王者']);
export const SHOP_PRICE_CHANGED_MESSAGE = '价格或段位发生变化，请刷新商城后重新确认购买';
export function shopDiscountRate(rank?: string | null) {
  return DISCOUNT_RANKS.has(rank?.trim() ?? '') ? 80 : 100;
}
/** 冠军币为整数，折后不足一币的部分向上取整；免费领取始终为零。 */
export function shopPurchasePrice(price: number, rank?: string | null) {
  return shopDiscountRate(rank) === 80 ? Math.ceil((price * 4) / 5) : price;
}
