import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { badRequest, notFound } from '@/server/api';
import { applyLedger, ensureWallet } from '@/server/points';
import { activeCosmetics as activeCosmeticsFrom } from '@/server/cosmetics';
import { readUpload } from '@/server/account';
import { imageContentType, putUploadedImage } from '@/server/uploads';
import {
  DYNAMIC_BACKGROUNDS,
  dynamicBackgroundValue,
  findDynamicBackground,
  isDynamicBackground,
  isValidDynamicBackground,
} from '@/lib/dynamic-backgrounds';
import { canClaimItem, claimEligibilityText } from '@/lib/shop-categories';
import { FEE_CARD_CODE, FEE_CARD_EFFECT, FEE_CARD_PURCHASE_CAP } from '@/lib/fee-reduction';
import { NAMEPLATES, NAMEPLATE_STYLES, nameplateImage, nameplateValue } from '@/lib/nameplates';
import { findAvatarFrame } from '@/lib/avatar-frames';
import { UNBAN_CARD_DESCRIPTION, UNBAN_CARD_REDUCTION_MS } from '@/lib/unban-card';
import {
  ALL_IN_CARD_CODE,
  ALL_IN_CARD_EFFECT,
  ALL_IN_CARD_PRICE,
  ALL_IN_CARD_DESCRIPTION,
  allInReward,
} from '@/lib/all-in-card';
import { settlePendingAllInCards } from '@/server/all-in-card';
import {
  SHOP_PRICE_CHANGED_MESSAGE,
  shopDiscountRate,
  shopPurchasePrice,
} from '@/lib/shop-pricing';

/** 商城与背包。 */

export const HERO_CARD_CODE = 'hero_protection_card';
export const HERO_CARD_PURCHASE_CAP = 5;
export const UNBAN_CARD_CODE = 'unban_card';
export const UNBAN_CARD_EFFECT = 'UNBAN_CARD';

const DEFAULT_ITEMS = [
  {
    code: ALL_IN_CARD_CODE,
    name: '梭哈卡',
    category: 'ITEM_CARD',
    icon: '/assets/items/all-in-card.svg',
    description: ALL_IN_CARD_DESCRIPTION,
    price: ALL_IN_CARD_PRICE,
    effectType: ALL_IN_CARD_EFFECT,
    effectJson: '{"type":"all_in_card"}',
    durationDays: null,
    groupCode: '',
  },
  ...NAMEPLATES.map((plate) => ({
    code: `nameplate_${plate.value}_perm`,
    name: `铭牌·${plate.label}（永久）`,
    category: 'NAMEPLATE',
    icon: plate.image,
    description: '专属图案与 LXL 徽记铺满报名信息栏。购买后自动佩戴，可在「我的」中切换或取消。',
    price: plate.price,
    effectType: 'DECORATION',
    effectJson: JSON.stringify({ type: 'nameplate', value: plate.value }),
    durationDays: null,
    groupCode: `nameplate_${plate.value}`,
  })),
  {
    code: UNBAN_CARD_CODE,
    name: '解禁卡',
    category: 'ITEM_CARD',
    icon: '🔓',
    description: UNBAN_CARD_DESCRIPTION,
    price: 300,
    effectType: UNBAN_CARD_EFFECT,
    effectJson: '{"type":"unban_card"}',
    durationDays: null,
    groupCode: '',
  },
  {
    code: FEE_CARD_CODE,
    name: '降费卡',
    category: 'ITEM_CARD',
    icon: '🎴',
    description:
      '队长报名后可主动使用，立即消耗1张。首轮选人排序降低3费，最低1费；第二轮恢复，队伍费用和预算不变。取消报名不退，仅管理员删除赛事退卡。每人累计限购5张。',
    price: 500,
    effectType: FEE_CARD_EFFECT,
    effectJson: '{"type":"fee_reduction_card"}',
    durationDays: null,
    groupCode: '',
  },
  {
    code: HERO_CARD_CODE,
    name: '免ban卡',
    category: 'ITEM_CARD',
    icon: '🛡️',
    description:
      '每队每轮限用一张，确认使用即消耗，仅当前轮保护一名英雄不被 ban；开赛后仍可使用。每人累计限购 5 张。',
    price: 300,
    effectType: 'HERO_PROTECTION_CARD',
    effectJson: '{}',
    durationDays: null,
    groupCode: '',
  },
  {
    code: 'title_seer_7d',
    name: '称号·赛季预言家（7天）',
    category: 'TITLE',
    icon: '🏅',
    description: '个人主页展示称号「赛季预言家」，有效期 7 天。',
    price: 10,
    effectType: 'DECORATION',
    effectJson: '{"type":"title","value":"赛季预言家"}',
    durationDays: 7,
    groupCode: 'title_seer',
  },
  {
    code: 'title_seer_30d',
    name: '称号·赛季预言家（30天）',
    category: 'TITLE',
    icon: '🏅',
    description: '个人主页展示称号「赛季预言家」，有效期 30 天。',
    price: 25,
    effectType: 'DECORATION',
    effectJson: '{"type":"title","value":"赛季预言家"}',
    durationDays: 30,
    groupCode: 'title_seer',
  },
  {
    code: 'title_seer_perm',
    name: '称号·赛季预言家（永久）',
    category: 'TITLE',
    icon: '🏅',
    description: '个人主页永久展示称号「赛季预言家」。',
    price: 60,
    effectType: 'DECORATION',
    effectJson: '{"type":"title","value":"赛季预言家"}',
    durationDays: null,
    groupCode: 'title_seer',
  },
  {
    code: 'title_founder_veteran',
    name: '称号·骨灰级元老（永久）',
    category: 'TITLE',
    icon: '🏅',
    description: '仅限注册前 10 名选手免费领取，个人主页永久展示称号「骨灰级元老」。',
    price: 0,
    effectType: 'DECORATION',
    effectJson: '{"type":"title","value":"骨灰级元老"}',
    durationDays: null,
    groupCode: 'title_founder_veteran',
    eligibleMinUserId: null,
    eligibleMaxUserId: 10,
  },
  {
    code: 'title_founder_earlybird',
    name: '称号·峡谷早起鸟（永久）',
    category: 'TITLE',
    icon: '🏅',
    description: '仅限注册第 11–20 名选手免费领取，个人主页永久展示称号「峡谷早起鸟」。',
    price: 0,
    effectType: 'DECORATION',
    effectJson: '{"type":"title","value":"峡谷早起鸟"}',
    durationDays: null,
    groupCode: 'title_founder_earlybird',
    eligibleMinUserId: 11,
    eligibleMaxUserId: 20,
  },
  {
    code: 'avatar_frame_gold_7d',
    name: '金色头像框（7天）',
    category: 'AVATAR_FRAME',
    icon: '🖼️',
    description: '个人主页与顶栏头像显示金色边框，有效期 7 天。',
    price: 8,
    effectType: 'DECORATION',
    effectJson: '{"type":"avatar_frame","value":"gold"}',
    durationDays: 7,
    groupCode: 'avatar_frame_gold',
  },
  {
    code: 'avatar_frame_gold_30d',
    name: '金色头像框（30天）',
    category: 'AVATAR_FRAME',
    icon: '🖼️',
    description: '个人主页与顶栏头像显示金色边框，有效期 30 天。',
    price: 20,
    effectType: 'DECORATION',
    effectJson: '{"type":"avatar_frame","value":"gold"}',
    durationDays: 30,
    groupCode: 'avatar_frame_gold',
  },
  {
    code: 'avatar_frame_gold_perm',
    name: '金色头像框（永久）',
    category: 'AVATAR_FRAME',
    icon: '🖼️',
    description: '个人主页与顶栏头像永久显示金色边框。',
    price: 50,
    effectType: 'DECORATION',
    effectJson: '{"type":"avatar_frame","value":"gold"}',
    durationDays: null,
    groupCode: 'avatar_frame_gold',
  },
  {
    code: 'background_kasa',
    name: '背景·卡莎·4K',
    category: 'BACKGROUND',
    icon: '🌌',
    description: '全局背景更换为「卡莎·4K」，购买后在「我的」里应用。',
    price: 15,
    effectType: 'DECORATION',
    effectJson: '{"type":"background","value":"/assets/bgs/02_kasa_4k.jpg"}',
    durationDays: null,
    groupCode: 'background_kasa',
  },
  {
    code: 'theme_ahri_guofeng',
    name: '主题·阿狸·国风',
    category: 'THEME',
    icon: '🎨',
    description: '全局背景更换为「阿狸·国风」主题，购买后在「我的」里应用。',
    price: 20,
    effectType: 'DECORATION',
    effectJson: '{"type":"theme","value":"/assets/bgs/03_ahri_guofeng.jpg"}',
    durationDays: null,
    groupCode: 'theme_ahri_guofeng',
  },
  {
    code: 'background_lux_4k',
    name: '背景·拉克丝·4K',
    category: 'BACKGROUND',
    icon: '🌌',
    description: '全局背景更换为「拉克丝·4K」，购买后在「我的」里应用。',
    price: 15,
    effectType: 'DECORATION',
    effectJson: '{"type":"background","value":"/assets/bgs/04_ahri_4k.jpg"}',
    durationDays: null,
    groupCode: 'background_lux_4k',
  },
  {
    code: 'background_riven_yujian',
    name: '背景·锐雯·玉剑',
    category: 'BACKGROUND',
    icon: '🌌',
    description: '全局背景更换为「锐雯·玉剑」，购买后在「我的」里应用。',
    price: 15,
    effectType: 'DECORATION',
    effectJson: '{"type":"background","value":"/assets/bgs/05_riven_yujian.jpg"}',
    durationDays: null,
    groupCode: 'background_riven_yujian',
  },
  {
    code: 'background_yone_classic',
    name: '背景·永恩·经典',
    category: 'BACKGROUND',
    icon: '🌌',
    description: '全局背景更换为「永恩·经典」，购买后在「我的」里应用。',
    price: 15,
    effectType: 'DECORATION',
    effectJson: '{"type":"background","value":"/assets/bgs/06_riven_classic.jpg"}',
    durationDays: null,
    groupCode: 'background_yone_classic',
  },
  {
    code: 'background_yasuo_preview',
    name: '背景·亚索·预知',
    category: 'BACKGROUND',
    icon: '🌌',
    description: '全局背景更换为「亚索·预知」，购买后在「我的」里应用。',
    price: 15,
    effectType: 'DECORATION',
    effectJson: '{"type":"background","value":"/assets/bgs/07_yasuo_preview.jpg"}',
    durationDays: null,
    groupCode: 'background_yasuo_preview',
  },
  {
    code: 'background_yasuo_project',
    name: '背景·亚索·源计划',
    category: 'BACKGROUND',
    icon: '🌌',
    description: '全局背景更换为「亚索·源计划」，购买后在「我的」里应用。',
    price: 15,
    effectType: 'DECORATION',
    effectJson: '{"type":"background","value":"/assets/bgs/08_yasuo_project.jpg"}',
    durationDays: null,
    groupCode: 'background_yasuo_project',
  },
  {
    code: 'background_zed',
    name: '背景·劫·暗影',
    category: 'BACKGROUND',
    icon: '🌌',
    description: '全局背景更换为「劫·暗影」，购买后在「我的」里应用。',
    price: 15,
    effectType: 'DECORATION',
    effectJson: '{"type":"background","value":"/assets/bgs/09_zed.jpg"}',
    durationDays: null,
    groupCode: 'background_zed',
  },
  // 代码实现的动态背景：上架全部 10 款，购买后在「我的」里应用。
  ...DYNAMIC_BACKGROUNDS.map((bg) => ({
    code: `dynamic_bg_${bg.key}`,
    name: `动态背景·${bg.label}`,
    category: 'BACKGROUND',
    icon: bg.icon,
    description: `全局背景切换为动态背景「${bg.label}」，购买后在「我的」里应用。`,
    price: 15,
    effectType: 'DECORATION',
    effectJson: JSON.stringify({ type: 'background', value: dynamicBackgroundValue(bg.key) }),
    durationDays: null,
    groupCode: `dynamic_bg_${bg.key}`,
  })),
];

/** 已废弃的旧商品 code：改名/换档前的残留，启动同步时清理掉（避免商城出现「两个永久」）。 */
const RETIRED_CODES = ['avatar_frame_gold', 'title_seer'];

let defaultShopItemsReady: Promise<void> | undefined;

/** 每个进程只初始化一次，并发请求共用任务；失败后允许重试，不缓存商品列表。 */
export function ensureDefaultShopItems() {
  if (!defaultShopItemsReady) {
    defaultShopItemsReady = initializeDefaultShopItems().catch((error) => {
      defaultShopItemsReady = undefined;
      throw error;
    });
  }
  return defaultShopItemsReady;
}

async function initializeDefaultShopItems() {
  if (RETIRED_CODES.length) {
    await prisma.shopItem.deleteMany({ where: { code: { in: RETIRED_CODES } } });
  }
  // 修复历史脏数据：
  // 1) 头像框/称号的 effectJson.value 曾被硬编码 "custom" → 修正为称号文本 / 金色样式。
  // 2) 图片头像框（icon 是图片）但 effectJson.value 仍是 "gold" → 同步为图片路径，保证每款独立。
  // 3) 后台新建商品 groupCode 为空 → 补成 code，保证「已拥有 / 防重复购买」按组判断唯一。
  const decorationCategories = ['TITLE', 'AVATAR_FRAME', 'BACKGROUND', 'THEME'];
  const dirty = await prisma.shopItem.findMany({
    where: { category: { in: decorationCategories } },
  });
  for (const item of dirty) {
    const patch: Prisma.ShopItemUpdateInput = {};
    if (!item.groupCode) patch.groupCode = item.code;
    try {
      const effect = JSON.parse(item.effectJson || '{}') as { type?: string; value?: string };
      if (item.category === 'AVATAR_FRAME') {
        const iconImage =
          item.icon && (item.icon.startsWith('http') || item.icon.startsWith('/')) ? item.icon : '';
        if (effect.value === 'custom' || (iconImage && effect.value !== iconImage)) {
          patch.effectJson = JSON.stringify({ type: 'avatar_frame', value: iconImage || 'gold' });
        }
      } else if (item.category === 'TITLE' && effect.value === 'custom') {
        patch.effectJson = JSON.stringify({ type: 'title', value: item.name });
      }
    } catch {
      // 忽略脏数据
    }
    if (Object.keys(patch).length) {
      await prisma.shopItem.update({ where: { id: item.id }, data: patch });
    }
  }
  // 一次批量补缺；code 唯一约束同时保留管理员修改和软删除的默认商品。
  await prisma.shopItem.createMany({ data: DEFAULT_ITEMS, skipDuplicates: true });
  // 已存在的默认商品也要展示新的抵扣和限购规则，保留管理员设置的价格等信息。
  await prisma.shopItem.updateMany({
    where: { code: UNBAN_CARD_CODE },
    data: { description: UNBAN_CARD_DESCRIPTION },
  });
  await prisma.shopItem.updateMany({
    where: { code: ALL_IN_CARD_CODE },
    data: { description: ALL_IN_CARD_DESCRIPTION },
  });
}

/** 判断一条背包装扮是否当前有效（未过期）。 */
function isActiveInventory(inv: { expiresAt: Date | null }) {
  return !inv.expiresAt || inv.expiresAt.getTime() > Date.now();
}

/** 解析装扮的 effectJson，返回 { type, value }；脏数据返回空串。 */
function parseEffectJson(json: string) {
  try {
    const effect = JSON.parse(json || '{}') as { type?: string; value?: string };
    return { type: effect.type ?? '', value: effect.value ?? '' };
  } catch {
    return { type: '', value: '' };
  }
}

export async function listShopItems(userId?: number) {
  await ensureDefaultShopItems();
  const [items, profile] = await Promise.all([
    prisma.shopItem.findMany({
      where: { enabled: true, deleted: false },
      orderBy: [{ price: 'asc' }, { id: 'asc' }],
    }),
    userId ? prisma.playerProfile.findUnique({ where: { userId }, select: { rank: true } }) : null,
  ]);
  return items.map((item) => ({
    ...item,
    originalPrice: item.price,
    price: shopPurchasePrice(item.price, profile?.rank),
    discountRate: shopDiscountRate(profile?.rank),
  }));
}

export async function buyItem(userId: number, itemId: number, expectedPrice?: number) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.shopItem.findUnique({ where: { id: itemId } });
    if (!item || !item.enabled || item.deleted) throw notFound('道具不存在或已下架');
    if (item.stock !== null && item.stock <= 0) throw badRequest('道具已售罄');
    if (!Number.isInteger(item.price) || item.price < 0) throw badRequest('道具定价无效');
    if (item.effectType === ALL_IN_CARD_EFFECT) {
      try {
        allInReward(item.price);
      } catch {
        throw badRequest('梭哈卡定价无效');
      }
    }
    // 0 币只允许用在「限定领取」商品上，避免误把普通商品设成白送。
    if (item.price === 0 && item.eligibleMinUserId === null && item.eligibleMaxUserId === null)
      throw badRequest('道具定价无效');
    // 限定领取：只有注册名次（User.id）落在范围内的选手可领取。
    if (!canClaimItem(userId, item.eligibleMinUserId, item.eligibleMaxUserId))
      throw badRequest(
        `该商品仅限${claimEligibilityText(item.eligibleMinUserId, item.eligibleMaxUserId)}领取`,
      );

    if (item.effectType === UNBAN_CARD_EFFECT) {
      // 与使用解禁卡共用用户行锁，避免并发购买或购买/使用交错时囤积卡片。
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const owned = await tx.userInventory.count({
        where: {
          userId,
          status: 'UNUSED',
          item: { effectType: UNBAN_CARD_EFFECT },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      if (owned > 0) throw badRequest('解禁卡每次限购1张，请先使用背包中未使用的解禁卡');
    }
    if (item.effectType === 'HERO_PROTECTION_CARD') {
      const owned = await tx.heroProtectionCard.count({
        where: { ownerId: userId, sourceMatchId: null },
      });
      if (owned >= HERO_CARD_PURCHASE_CAP)
        throw badRequest(`免ban卡每人累计限购 ${HERO_CARD_PURCHASE_CAP} 张`);
    }
    if (item.effectType === FEE_CARD_EFFECT) {
      // 锁住购买者，串行校验限购；已使用或删除的背包物品仍计入累计订单数。
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const purchased = await tx.shopOrder.count({
        where: {
          userId,
          status: 'SUCCESS',
          itemId: {
            in: (
              await tx.shopItem.findMany({
                where: { effectType: FEE_CARD_EFFECT },
                select: { id: true },
              })
            ).map((row) => row.id),
          },
        },
      });
      if (purchased >= FEE_CARD_PURCHASE_CAP) throw badRequest('降费卡每人累计限购5张');
    }

    // 装扮类：同一组（groupCode）已有未过期装扮时禁止重复购买；道具卡走上面的限购逻辑。
    // 每款装扮（头像框/称号/背景/主题）都是独立的，只有同一组的多个时长档位才算重复。
    if (item.effectType === 'DECORATION') {
      const group = item.groupCode || item.code;
      const ownedItems = await tx.userInventory.findMany({
        where: { userId, status: 'UNUSED', item: { groupCode: group } },
        select: { expiresAt: true },
      });
      if (ownedItems.some(isActiveInventory))
        throw badRequest('你已拥有该装扮（未过期），不能重复购买');
    }

    // 计算到期时间：永久道具 expiresAt = null。
    const expiresAt =
      item.durationDays && item.durationDays > 0
        ? new Date(Date.now() + item.durationDays * 24 * 3600_000)
        : null;

    const profile = await tx.playerProfile.findUnique({
      where: { userId },
      select: { rank: true },
    });
    const paidPrice = shopPurchasePrice(item.price, profile?.rank);
    if (expectedPrice !== undefined && expectedPrice !== paidPrice)
      throw badRequest(SHOP_PRICE_CHANGED_MESSAGE);
    const balance =
      paidPrice > 0
        ? await applyLedger(tx, userId, -paidPrice, 'SHOP_SPEND', 'SHOP', item.id, '')
        : (await ensureWallet(tx, userId)).balance;
    const order = await tx.shopOrder.create({
      data: { userId, itemId: item.id, price: paidPrice, originalPrice: item.price },
    });

    if (item.effectType === 'HERO_PROTECTION_CARD') {
      // 商城购买 = 直接发一张免ban卡（sourceMatchId 为空，与 FMVP/夺冠奖励区分）。
      await tx.heroProtectionCard.create({ data: { ownerId: userId, awardType: 'SHOP' } });
    } else {
      const inventory = await tx.userInventory.create({
        data: { userId, itemId: item.id, orderId: order.id, expiresAt },
      });
      // 头像框 / 称号购买后自动佩戴最新一款（之后可在「我的」里切换或取消佩戴）。
      try {
        const effect = JSON.parse(item.effectJson || '{}') as { type?: string; value?: string };
        if (effect.type === 'avatar_frame' && effect.value) {
          await tx.user.update({ where: { id: userId }, data: { avatarFrame: effect.value } });
        } else if (effect.type === 'title' && effect.value) {
          await tx.user.update({ where: { id: userId }, data: { title: effect.value } });
        } else if (item.category === 'NAMEPLATE' && nameplateValue(item.effectJson)) {
          await tx.user.update({
            where: { id: userId },
            data: { nameplateInventoryId: inventory.id },
          });
        }
      } catch {
        // 忽略脏数据
      }
    }

    if (item.stock !== null) {
      await tx.shopItem.update({ where: { id: item.id }, data: { stock: { decrement: 1 } } });
    }
    return {
      order_id: order.id,
      item: item.name,
      price: paidPrice,
      original_price: item.price,
      discount_rate: shopDiscountRate(profile?.rank),
      balance,
      expires_at: expiresAt?.toISOString() ?? null,
    };
  });
}

/** 当前生效的装扮（头像框 / 称号）：取未过期、最新购买的一条。 */
export async function activeCosmetics(userId: number) {
  return activeCosmeticsFrom(userId);
}

export async function getInventory(userId: number) {
  await settlePendingAllInCards(userId);
  const [items, wallet, account] = await Promise.all([
    prisma.userInventory.findMany({
      where: { userId },
      include: {
        allInCardUse: {
          select: { matchId: true, teamName: true, status: true, reward: true, payout: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    ensureWallet(prisma, userId),
    prisma.user.findUnique({ where: { id: userId }, select: { banUntil: true } }),
  ]);
  const now = Date.now();
  const enriched = [];
  for (const inv of items) {
    const item = await prisma.shopItem.findUnique({ where: { id: inv.itemId } });
    let effectType = '';
    let effectValue = '';
    try {
      const effect = JSON.parse(item?.effectJson ?? '{}') as { type?: string; value?: string };
      effectType = effect.type ?? '';
      effectValue = effect.value ?? '';
    } catch {
      // 忽略脏数据
    }
    enriched.push({
      ...inv,
      item,
      effect_type: effectType,
      effect_value: effectValue,
      active: !inv.expiresAt || inv.expiresAt.getTime() > now,
      expires_at: inv.expiresAt?.toISOString() ?? null,
    });
  }
  return {
    items: enriched,
    balance: wallet.balance,
    ban_until: account?.banUntil?.toISOString() ?? null,
  };
}

/** 每张抵扣72小时报名封禁；同一用户的并发购买和使用串行处理。 */
export async function useUnbanCard(userId: number, inventoryId: number) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const inv = await tx.userInventory.findUnique({
      where: { id: inventoryId },
      include: { item: { select: { effectType: true } } },
    });
    if (!inv || inv.userId !== userId) throw notFound('物品不存在或不属于你');
    if (inv.item.effectType !== UNBAN_CARD_EFFECT) throw badRequest('该物品不是解禁卡');
    if (inv.status !== 'UNUSED') throw badRequest('该解禁卡已使用或不可用');
    const now = new Date();
    if (inv.expiresAt && inv.expiresAt.getTime() <= now.getTime())
      throw badRequest('该解禁卡已过期');
    const account = await tx.user.findUnique({ where: { id: userId }, select: { banUntil: true } });
    if (!account?.banUntil || account.banUntil.getTime() <= now.getTime())
      throw badRequest('当前没有生效的封禁，无需使用解禁卡');
    const used = await tx.userInventory.updateMany({
      where: { id: inventoryId, userId, status: 'UNUSED' },
      data: { status: 'USED', usedAt: now },
    });
    if (used.count !== 1) throw badRequest('解禁卡状态已变化，请刷新后重试');
    const reducedUntil = account.banUntil.getTime() - UNBAN_CARD_REDUCTION_MS;
    const banUntil = reducedUntil > now.getTime() ? new Date(reducedUntil) : null;
    await tx.user.update({ where: { id: userId }, data: { banUntil } });
    return {
      msg: banUntil
        ? '已使用解禁卡，报名封禁已缩短3天，剩余封禁结束后即可报名'
        : '已使用解禁卡，剩余封禁已解除，可以重新报名',
      inventory_id: inventoryId,
      ban_until: banUntil?.toISOString() ?? null,
    };
  });
}

/** 应用背包里的背景/主题到全局背景（backgroundImage）。 */
export async function applyInventoryItem(userId: number, inventoryId: number) {
  const inv = await prisma.userInventory.findUnique({
    where: { id: inventoryId },
    include: { item: { select: { effectJson: true, name: true } } },
  });
  if (!inv || inv.userId !== userId) throw notFound('物品不存在或不属于你');
  if (inv.expiresAt && inv.expiresAt.getTime() < Date.now())
    throw badRequest('该物品已过期，无法应用');

  let type = '';
  let value = '';
  try {
    const effect = JSON.parse(inv.item.effectJson || '{}') as { type?: string; value?: string };
    type = effect.type ?? '';
    value = effect.value ?? '';
  } catch {
    // 忽略
  }
  if (type !== 'background' && type !== 'theme') throw badRequest('该物品无需手动应用');
  if (!value || (!value.startsWith('/') && !isDynamicBackground(value)))
    throw badRequest('该物品没有可应用的背景');

  await prisma.user.update({ where: { id: userId }, data: { backgroundImage: value } });
  return { msg: '背景已应用', background: value, item: inv.item.name };
}

/** 删除背包物品；若删除的是当前佩戴的头像框 / 称号，一并取消佩戴。 */
export async function deleteInventoryItem(userId: number, inventoryId: number) {
  const inv = await prisma.userInventory.findUnique({
    where: { id: inventoryId },
    include: { item: { select: { name: true, effectJson: true } } },
  });
  if (!inv || inv.userId !== userId) throw notFound('物品不存在或不属于你');
  if (await prisma.matchFeeCardUse.findUnique({ where: { inventoryId } }))
    throw badRequest('该降费卡已用于赛事，只有管理员删除赛事才会退回，不能删除');
  if (await prisma.matchAllInCardUse.findUnique({ where: { inventoryId } }))
    throw badRequest('梭哈卡已用于赛事，请保留结算凭证，不能删除');

  let effectValue = '';
  let effectType = '';
  try {
    const effect = JSON.parse(inv.item.effectJson || '{}') as { type?: string; value?: string };
    effectValue = effect.value ?? '';
    effectType = effect.type ?? '';
  } catch {
    // 忽略脏数据
  }

  await prisma.$transaction(async (tx) => {
    if (effectType === 'all_in_card') {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      if (await tx.matchAllInCardUse.findUnique({ where: { inventoryId } }))
        throw badRequest('梭哈卡已用于赛事，请保留结算凭证，不能删除');
    }
    await tx.userInventory.delete({ where: { id: inventoryId } });
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        avatarFrameInventoryId: true,
        title: true,
        titleInventoryId: true,
        nameplateInventoryId: true,
      },
    });
    if (user?.avatarFrameInventoryId === inventoryId) {
      await tx.user.update({
        where: { id: userId },
        data: { avatarFrame: '', avatarFrameInventoryId: null },
      });
    }
    if (user?.nameplateInventoryId === inventoryId) {
      await tx.user.update({ where: { id: userId }, data: { nameplateInventoryId: null } });
    }
    // 称号通过背包 id 或文本值都能定位到佩戴中的那条，删除后一并取消佩戴。
    if (
      effectType === 'title' &&
      (user?.titleInventoryId === inventoryId || (effectValue && user?.title === effectValue))
    ) {
      await tx.user.update({
        where: { id: userId },
        data: { title: '', titleInventoryId: null },
      });
    }
  });
  return { msg: '物品已删除', item: inv.item.name };
}

/** 管理员：商品列表（含下架，不含已删除）。 */
export async function adminListShopItems() {
  // Shared database bootstrap/legacy repairs remain owned by the user service.
  // Opening an independent management list must not seed, delete or repair data.
  return prisma.shopItem.findMany({
    where: { deleted: false },
    orderBy: [{ category: 'asc' }, { price: 'asc' }, { id: 'asc' }],
  });
}

/** 管理员：上传商城图标（multipart 字段 `file`），返回可访问的图片路径。 */
export async function uploadShopIcon(adminId: number, file: unknown) {
  const upload = await readUpload(file, undefined, { allowSvg: true });
  if (!upload.ok) throw badRequest(upload.error);
  const name = `s${adminId}_${Date.now()}${upload.ext}`;
  await putUploadedImage('shop-icons', name, upload.buffer, imageContentType(name)!);
  return { url: `/assets/shop-icons/${name}` };
}

/** 内置样式限定为资源目录中的已登记设计；自定义图片沿用上传流程。 */
function selectedAvatarFrame(style: unknown, icon: string) {
  const value = String(style ?? '').trim();
  if (!value)
    return { icon, value: icon.startsWith('/') || icon.startsWith('http') ? icon : 'gold' };
  const preset = findAvatarFrame(value);
  if (!preset) throw badRequest('请选择有效的内置头像框或自定义图片');
  return { icon: preset.image, value: preset.value };
}

/** 分类 → 装扮效果映射，内置头像框与上传图片均保存可直接渲染的值。 */
function categoryEffect(
  category: string,
  name: string,
  effectValue?: string,
  icon?: string,
  dynamicBg = '',
) {
  const value = (effectValue ?? '').trim();
  const iconImage = icon && (icon.startsWith('http') || icon.startsWith('/')) ? icon : '';
  switch (category) {
    case 'NAMEPLATE': {
      const plate = value === 'custom' ? iconImage : value || 'champion';
      if (!nameplateImage(plate)) throw badRequest('铭牌请选择内置样式，或上传自定义横幅图片');
      return {
        effectType: 'DECORATION',
        effectJson: JSON.stringify({ type: 'nameplate', value: plate }),
      };
    }
    case 'AVATAR_FRAME':
      return {
        effectType: 'DECORATION',
        effectJson: JSON.stringify({ type: 'avatar_frame', value: value || iconImage || 'gold' }),
      };
    case 'TITLE':
      return {
        effectType: 'DECORATION',
        effectJson: JSON.stringify({ type: 'title', value: value || name }),
      };
    case 'BACKGROUND':
      if (dynamicBg) {
        return {
          effectType: 'DECORATION',
          effectJson: JSON.stringify({
            type: 'background',
            value: dynamicBackgroundValue(dynamicBg),
          }),
        };
      }
      return {
        effectType: 'DECORATION',
        effectJson: JSON.stringify({ type: 'background', value: value || iconImage }),
      };
    case 'THEME':
      return {
        effectType: 'DECORATION',
        effectJson: JSON.stringify({ type: 'theme', value }),
      };
    default:
      return { effectType: 'DECORATION', effectJson: '{}' };
  }
}

/** 解析领取资格的名次边界：空值表示该侧不限，填写时必须是正整数。 */
function parseRankBound(raw: unknown, label: string) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`${label}无效`);
  return value;
}

/** 校验「0 币」只能用于限定领取商品，避免普通商品被设成白送。 */
function assertFreePriceAllowed(price: number, min: number | null, max: number | null) {
  if (!Number.isInteger(price) || price < 0) throw badRequest('定价需为非负整数');
  if (price === 0 && min === null && max === null)
    throw badRequest('0 币仅限设置了领取资格的限定商品');
}

/** 管理员：新建商品（分类/图标/名称/价格/时长/描述/效果值）。 */
export async function adminCreateShopItem(body: Record<string, unknown>) {
  const category = String(body.category ?? 'ITEM_CARD');
  if (
    !['AVATAR_FRAME', 'TITLE', 'NAMEPLATE', 'BACKGROUND', 'THEME', 'ITEM_CARD'].includes(category)
  )
    throw badRequest('分类无效');

  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('请填写商品名称');
  let icon = String(body.icon ?? '').trim();
  const description = String(body.description ?? '').trim();
  let effectValue = String(body.effectValue ?? '').trim();
  if (category === 'AVATAR_FRAME' && body.avatarFrameStyle !== undefined) {
    const frame = selectedAvatarFrame(body.avatarFrameStyle, icon);
    icon = frame.icon;
    effectValue = frame.value;
  }
  // 动态背景：代码实现，无需上传图片。key 来自白名单（如 meteor / pink）。
  const dynamicBg = category === 'BACKGROUND' ? String(body.dynamicBg ?? '').trim() : '';

  // 主题暂未开放；背景分两种：动态背景（无需图片）或图片背景（上传图标）。
  if (category === 'THEME') throw badRequest('主题暂未开放');
  if (category === 'BACKGROUND' && !dynamicBg && !effectValue) {
    const iconImage = icon.startsWith('http') || icon.startsWith('/') ? icon : '';
    if (!iconImage) throw badRequest('背景商品请选择动态背景或上传背景图');
  }
  if (dynamicBg) {
    if (!isValidDynamicBackground(dynamicBg)) throw badRequest('动态背景无效');
    if (!icon) icon = findDynamicBackground(dynamicBackgroundValue(dynamicBg))?.icon ?? '';
  }

  const eligibleMinUserId = parseRankBound(body.eligibleMinUserId, '领取起始名次');
  const eligibleMaxUserId = parseRankBound(body.eligibleMaxUserId, '领取截止名次');
  if (
    eligibleMinUserId !== null &&
    eligibleMaxUserId !== null &&
    eligibleMinUserId > eligibleMaxUserId
  )
    throw badRequest('领取名次范围无效');

  const price = Number(body.price);
  assertFreePriceAllowed(price, eligibleMinUserId, eligibleMaxUserId);

  const rawDuration = body.durationDays;
  const durationDays =
    rawDuration === null || rawDuration === undefined || rawDuration === ''
      ? null
      : Number(rawDuration);
  if (durationDays !== null && (!Number.isInteger(durationDays) || durationDays <= 0))
    throw badRequest('时长无效');

  const { effectType, effectJson } = categoryEffect(category, name, effectValue, icon, dynamicBg);

  // 生成唯一 code：分类小写 + 随机后缀。
  const code = `${category.toLowerCase()}_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const item = await prisma.shopItem.create({
    data: {
      code,
      category,
      icon,
      name,
      description,
      price,
      durationDays,
      effectType,
      effectJson,
      // 后台新建商品默认独立成组（groupCode 唯一），保证「已拥有」按组判断。
      groupCode: code,
      eligibleMinUserId,
      eligibleMaxUserId,
    },
  });
  return { msg: '商品已创建', item_id: item.id };
}

/** 管理员：更新商品（分类/图标/名称/价格/时长/库存/上下架）。 */
export async function adminUpdateShopItem(itemId: number, body: Record<string, unknown>) {
  const existing = await prisma.shopItem.findUnique({
    where: { id: itemId },
    select: {
      category: true,
      effectJson: true,
      icon: true,
      name: true,
      price: true,
      eligibleMinUserId: true,
      eligibleMaxUserId: true,
    },
  });
  if (!existing) throw notFound('商品不存在');
  const existingEffect = parseEffectJson(existing.effectJson);

  const data: Prisma.ShopItemUpdateInput = {};
  let category = existing.category;
  if (body.category !== undefined) {
    category = String(body.category);
    if (
      !['AVATAR_FRAME', 'TITLE', 'NAMEPLATE', 'BACKGROUND', 'THEME', 'ITEM_CARD'].includes(category)
    )
      throw badRequest('分类无效');
    data.category = category;
  }
  let icon: string | undefined;
  if (body.icon !== undefined) {
    icon = String(body.icon);
    data.icon = icon;
  }
  if (category === 'NAMEPLATE') {
    const previousStyle = NAMEPLATE_STYLES.some((plate) => plate.value === existingEffect.value)
      ? existingEffect.value
      : 'custom';
    const style =
      body.effectValue !== undefined
        ? String(body.effectValue).trim()
        : existing.category === 'NAMEPLATE'
          ? previousStyle
          : 'champion';
    Object.assign(data, categoryEffect(category, existing.name, style, icon ?? existing.icon));
  }

  // 头像框的图片图标即头像框效果：图标变化时同步 effectJson.value（图片优先，emoji 回退 gold）。
  // 变化后同步所有正在佩戴该旧值的用户，避免其他人仍看到旧头像框。
  let frameWearerPatch: { oldValue: string; newValue: string } | null = null;
  if (
    category === 'AVATAR_FRAME' &&
    (icon !== undefined || body.avatarFrameStyle !== undefined || existing.category !== category)
  ) {
    const frame = selectedAvatarFrame(body.avatarFrameStyle, icon ?? existing.icon);
    const newValue = frame.value;
    data.icon = frame.icon;
    if (newValue !== existingEffect.value || existing.category !== category) {
      data.effectType = 'DECORATION';
      data.effectJson = JSON.stringify({ type: 'avatar_frame', value: newValue });
      if (existing.category === 'AVATAR_FRAME' && existingEffect.value) {
        frameWearerPatch = { oldValue: existingEffect.value, newValue };
      }
    }
  }
  // 背景支持动态背景（代码实现）或图片背景：变化时同步 effectJson.value，并同步所有正在使用的用户。
  let backgroundWearerPatch: { oldValue: string; newValue: string } | null = null;
  if (category === 'BACKGROUND') {
    const dynamicBgRaw = body.dynamicBg !== undefined ? String(body.dynamicBg).trim() : undefined;
    let newValue: string | null = null;
    if (dynamicBgRaw) {
      if (!isValidDynamicBackground(dynamicBgRaw)) throw badRequest('动态背景无效');
      newValue = dynamicBackgroundValue(dynamicBgRaw);
      if (!icon) {
        const defaultIcon = findDynamicBackground(newValue)?.icon ?? '';
        if (defaultIcon) data.icon = defaultIcon;
      }
    } else if (icon !== undefined) {
      const iconImage = icon.startsWith('http') || icon.startsWith('/') ? icon : '';
      if (iconImage) newValue = iconImage;
    }
    if (newValue && newValue !== existingEffect.value) {
      data.effectJson = JSON.stringify({ type: 'background', value: newValue });
      if (existingEffect.value) {
        backgroundWearerPatch = { oldValue: existingEffect.value, newValue };
      }
    }
  }
  if (body.name !== undefined) data.name = String(body.name);
  if (body.description !== undefined) data.description = String(body.description);
  let price = existing.price;
  if (body.price !== undefined) {
    price = Number(body.price);
    data.price = price;
  }
  let eligibleMinUserId = existing.eligibleMinUserId;
  if (body.eligibleMinUserId !== undefined) {
    eligibleMinUserId = parseRankBound(body.eligibleMinUserId, '领取起始名次');
    data.eligibleMinUserId = eligibleMinUserId;
  }
  let eligibleMaxUserId = existing.eligibleMaxUserId;
  if (body.eligibleMaxUserId !== undefined) {
    eligibleMaxUserId = parseRankBound(body.eligibleMaxUserId, '领取截止名次');
    data.eligibleMaxUserId = eligibleMaxUserId;
  }
  assertFreePriceAllowed(price, eligibleMinUserId, eligibleMaxUserId);
  if (
    eligibleMinUserId !== null &&
    eligibleMaxUserId !== null &&
    eligibleMinUserId > eligibleMaxUserId
  )
    throw badRequest('领取名次范围无效');
  if (body.durationDays !== undefined) {
    const raw = body.durationDays;
    const durationDays = raw === null || raw === '' ? null : Number(raw);
    if (durationDays !== null && (!Number.isInteger(durationDays) || durationDays <= 0))
      throw badRequest('时长无效');
    data.durationDays = durationDays;
  }
  if (body.stock !== undefined) {
    const stock = body.stock === null ? null : Number(body.stock);
    if (stock !== null && (!Number.isInteger(stock) || stock < 0)) throw badRequest('库存无效');
    data.stock = stock as number | null;
  }
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);

  // 称号文本同步：显式填写称号文本 → 用称号文本；否则称号文本跟随名称（仅当当前称号文本就是旧名称，即未自定义过）。
  if (category === 'TITLE') {
    const effectValue = body.effectValue !== undefined ? String(body.effectValue).trim() : '';
    const newName = body.name !== undefined ? String(body.name).trim() : '';
    if (effectValue) {
      data.effectJson = JSON.stringify({ type: 'title', value: effectValue });
    } else if (newName && existingEffect.value === existing.name) {
      data.effectJson = JSON.stringify({ type: 'title', value: newName });
    }
  }

  await prisma.shopItem.update({ where: { id: itemId }, data });
  if (frameWearerPatch) {
    await prisma.user.updateMany({
      where: { avatarFrame: frameWearerPatch.oldValue },
      data: { avatarFrame: frameWearerPatch.newValue },
    });
  }
  if (backgroundWearerPatch) {
    await prisma.user.updateMany({
      where: { backgroundImage: backgroundWearerPatch.oldValue },
      data: { backgroundImage: backgroundWearerPatch.newValue },
    });
  }
  return { msg: '商品已更新' };
}

/** 管理员：软删除商品。仅从商城/后台列表移除，用户已购背包不受影响（记录保留）。 */
export async function adminDeleteShopItem(itemId: number) {
  const item = await prisma.shopItem.findUnique({
    where: { id: itemId },
    select: { id: true, name: true },
  });
  if (!item) throw notFound('商品不存在');
  await prisma.shopItem.update({
    where: { id: itemId },
    data: { deleted: true, enabled: false },
  });
  return { msg: '商品已删除', item: item.name };
}
