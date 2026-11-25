import { prisma } from '@/lib/prisma';
import { nameplateValue } from '@/lib/nameplates';
import { badRequest, notFound } from '@/server/api';

/** Batch lookup for registration lists; no per-player inventory requests. */
export async function activeNameplatesForUsers(
  users: { id: number; nameplateInventoryId: number | null }[],
) {
  const wearers = new Map(
    users
      .filter((user) => user.nameplateInventoryId !== null)
      .map((user) => [user.id, user.nameplateInventoryId!]),
  );
  const result = new Map<number, string>();
  if (wearers.size === 0) return result;
  const inventories = await prisma.userInventory.findMany({
    where: {
      id: { in: [...wearers.values()] },
      userId: { in: [...wearers.keys()] },
      status: 'UNUSED',
      item: { category: 'NAMEPLATE', effectType: 'DECORATION' },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, userId: true, item: { select: { effectJson: true } } },
  });
  for (const inventory of inventories) {
    const value = nameplateValue(inventory.item.effectJson);
    if (value && wearers.get(inventory.userId) === inventory.id)
      result.set(inventory.userId, value);
  }
  return result;
}

export async function setNameplate(userId: number, inventoryId: number | null) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (inventoryId !== null) {
      const inventory = await tx.userInventory.findUnique({
        where: { id: inventoryId },
        include: { item: true },
      });
      if (!inventory || inventory.userId !== userId) throw notFound('铭牌不存在或不属于你');
      if (
        inventory.status !== 'UNUSED' ||
        (inventory.expiresAt && inventory.expiresAt.getTime() <= Date.now())
      )
        throw badRequest('该铭牌已过期或不可用');
      if (
        inventory.item.category !== 'NAMEPLATE' ||
        inventory.item.effectType !== 'DECORATION' ||
        !nameplateValue(inventory.item.effectJson)
      )
        throw badRequest('该物品不是可佩戴的铭牌');
    }
    await tx.user.update({ where: { id: userId }, data: { nameplateInventoryId: inventoryId } });
    return { inventoryId };
  });
}
