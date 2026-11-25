export const ALL_IN_CARD_CODE = 'all_in_card';
export const ALL_IN_CARD_EFFECT = 'ALL_IN_CARD';
export const ALL_IN_CARD_PRICE = 300;
export const ALL_IN_CARD_DESCRIPTION =
  '加入当天赛事队伍后、开赛前使用，每人每场限1张。立即消耗并绑定使用时的队伍；该队夺冠返还购买时原价的3倍（原价300币返900币，八折240币购入同享900币），未夺冠不返还。冠军池奖励另计；取消报名或离队不改变绑定队伍、不退卡。';
export function allInReward(price: number) {
  if (!Number.isInteger(price) || price <= 0 || price * 3 > 2_147_483_647)
    throw new Error('梭哈卡原价无效');
  return price * 3;
}
/** 北京时间自然日；不依赖部署服务器时区。 */
export function allInDayBounds(now = new Date()) {
  const day = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
export function isAllInMatchToday(match: { date: Date | null; createdAt: Date }, now = new Date()) {
  const { start, end } = allInDayBounds(now);
  const at = match.date ?? match.createdAt;
  return at >= start && at < end;
}
