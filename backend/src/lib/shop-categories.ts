/** 商城固定分类（前后端共用，无 prisma 依赖）。 */

export type ShopCategory =
  'AVATAR_FRAME' | 'TITLE' | 'NAMEPLATE' | 'BACKGROUND' | 'THEME' | 'ITEM_CARD';

export const SHOP_CATEGORIES: { value: ShopCategory; label: string; icon: string }[] = [
  { value: 'AVATAR_FRAME', label: '头像框', icon: '🖼️' },
  { value: 'TITLE', label: '称号', icon: '🏅' },
  { value: 'NAMEPLATE', label: '铭牌', icon: '🎖️' },
  { value: 'BACKGROUND', label: '背景', icon: '🌌' },
  { value: 'THEME', label: '主题', icon: '🎨' },
  { value: 'ITEM_CARD', label: '道具卡', icon: '🛡️' },
];

/** 商城当前开放的分类（主题暂未开放，数据保留但不在商城/后台展示）。 */
export const VISIBLE_SHOP_CATEGORIES = SHOP_CATEGORIES.filter((c) => c.value !== 'THEME');

export function categoryLabel(value: string) {
  return SHOP_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

export function categoryIcon(value: string) {
  return SHOP_CATEGORIES.find((c) => c.value === value)?.icon ?? '';
}

/** 图标值是图片（本地路径或远程 URL）而不是 emoji 时返回 true。 */
export function isIconImage(icon: string) {
  return icon.startsWith('http') || icon.startsWith('/');
}

/**
 * GIF 装饰素材通常带不透明黑底，头像框渲染时用色键滤镜转成透明。
 * 保留原始 img，由浏览器继续播放动画。
 */
export function isBlackBackgroundImage(src: string) {
  return /\.gif(\?|#|$)/i.test(src);
}

/**
 * 领取资格范围文案：只有注册名次落在 [min, max] 内的选手可以领取。
 * 两个边界都为 null 表示不限（返回空串）。
 */
export function claimEligibilityText(min: number | null, max: number | null) {
  if (min !== null && max !== null) return `注册第 ${min}–${max} 名选手`;
  if (min !== null) return `注册第 ${min} 名及之后的选手`;
  if (max !== null) return `注册前 ${max} 名选手`;
  return '';
}

/** 当前用户是否满足商品的领取资格（两个边界都为 null 时不限）。 */
export function canClaimItem(
  userId: number | null | undefined,
  min: number | null,
  max: number | null,
) {
  if (min === null && max === null) return true;
  if (userId === null || userId === undefined) return false;
  if (min !== null && userId < min) return false;
  if (max !== null && userId > max) return false;
  return true;
}
