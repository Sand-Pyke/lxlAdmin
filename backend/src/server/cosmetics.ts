import { prisma } from '@/lib/prisma';
import { nameplateValue } from '@/lib/nameplates';

/**
 * 装扮（头像框 / 称号 / 报名铭牌）查询，避免与 auth/shop 之间的循环依赖。
 */

export type Cosmetics = { type: string; value: string; name: string; inventoryId?: number }[];

/**
 * 当前生效的装扮：头像框 / 称号均按「佩戴状态」生效
 * （头像框 User.avatarFrame / avatarFrameInventoryId，称号 User.title / titleInventoryId）。
 */
export async function activeCosmetics(userId: number): Promise<Cosmetics> {
  const [active, user] = await Promise.all([
    prisma.userInventory.findMany({
      where: {
        userId,
        status: 'UNUSED',
        item: { effectType: 'DECORATION' },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: { item: { select: { effectJson: true, name: true, category: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        avatarFrame: true,
        avatarFrameInventoryId: true,
        title: true,
        titleInventoryId: true,
        nameplateInventoryId: true,
      },
    }),
  ]);

  const frames: { id: number; value: string; name: string }[] = [];
  const titles: { id: number; value: string; name: string }[] = [];
  for (const inv of active) {
    try {
      const effect = JSON.parse(inv.item.effectJson || '{}') as { type?: string; value?: string };
      const type = effect.type ?? '';
      const value = effect.value ?? '';
      if (type === 'avatar_frame' && value) frames.push({ id: inv.id, value, name: inv.item.name });
      else if (type === 'title' && value) titles.push({ id: inv.id, value, name: inv.item.name });
    } catch {
      // 忽略脏数据
    }
  }

  const result: Cosmetics = [];
  // 头像框以佩戴值为准：优先按具体背包记录 id 精确匹配，历史数据回退按 value 匹配。
  const worn = user?.avatarFrame ?? '';
  if (worn) {
    const wornInventoryId = user?.avatarFrameInventoryId ?? null;
    const match =
      frames.find((frame) => wornInventoryId !== null && frame.id === wornInventoryId) ??
      frames.find((frame) => frame.value === worn);
    if (match) {
      result.push({
        type: 'avatar_frame',
        value: match.value,
        name: match.name,
        inventoryId: match.id,
      });
    }
  }
  // 称号同样以佩戴值为准：优先按具体背包记录 id 精确匹配，历史数据回退按 value 匹配。
  const wornTitle = user?.title ?? '';
  if (wornTitle) {
    const wornTitleInventoryId = user?.titleInventoryId ?? null;
    const match =
      titles.find((title) => wornTitleInventoryId !== null && title.id === wornTitleInventoryId) ??
      titles.find((title) => title.value === wornTitle);
    if (match) {
      result.push({
        type: 'title',
        value: match.value,
        name: match.name,
        inventoryId: match.id,
      });
    }
  }
  const plate = active.find(
    (inventory) =>
      inventory.id === user?.nameplateInventoryId && inventory.item.category === 'NAMEPLATE',
  );
  const plateValue = plate ? nameplateValue(plate.item.effectJson) : '';
  if (plate && plateValue)
    result.push({
      type: 'nameplate',
      value: plateValue,
      name: plate.item.name,
      inventoryId: plate.id,
    });
  return result;
}
