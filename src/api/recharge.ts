import { MAX_INT } from './shop.ts';
export type RechargeBody = { userId: number; amount: number; note: string };
export type RechargeResult = { user_id: number; amount: number; balance: number; note: string };
export function rechargeBody(
  userId: number | undefined,
  amount: number | null,
  note = '',
): RechargeBody {
  if (!Number.isInteger(userId) || !userId || userId < 1) throw new Error('请搜索并选择充值用户');
  if (!Number.isInteger(amount) || amount === null || amount < 1 || amount > MAX_INT)
    throw new Error('充值金额必须是有效的正整数');
  return { userId, amount, note: note.trim() };
}
