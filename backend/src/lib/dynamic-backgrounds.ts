/**
 * 代码实现的动态背景（非图片）：流星雨、可爱粉红系等。
 * value 统一用 `fx:` 前缀 + key 存储（如 "fx:meteor"），与图片路径区分；
 * 前端据此给背景层加 `league-page-bg--{key}` 类渲染 CSS 动画。
 * 服务端与前端共用，不能依赖 Prisma。
 */

export type DynamicBackground = { key: string; label: string; icon: string };

export const DYNAMIC_BACKGROUNDS: readonly DynamicBackground[] = [
  { key: 'meteor', label: '流星雨', icon: '🌠' },
  { key: 'pink', label: '可爱粉红系', icon: '🌸' },
  { key: 'aurora', label: '极光', icon: '🌌' },
  { key: 'galaxy', label: '星空银河', icon: '✨' },
  { key: 'cyber', label: '赛博霓虹', icon: '🌆' },
  { key: 'ember', label: '烈焰余烬', icon: '🔥' },
  { key: 'ocean', label: '深海气泡', icon: '🌊' },
  { key: 'snow', label: '雪夜', icon: '❄️' },
  { key: 'sakura', label: '樱花飘落', icon: '🍃' },
  { key: 'nebula', label: '星云', icon: '💫' },
  { key: 'love520', label: '520 粉嫩少女', icon: '💗' },
];

export const DYNAMIC_BG_PREFIX = 'fx:';

/** 判断某个背景 value 是否为代码动态背景（而非图片路径）。 */
export function isDynamicBackground(value: string): boolean {
  return value.startsWith(DYNAMIC_BG_PREFIX);
}

/** 动态背景 value → 背景层 CSS 类名。 */
export function dynamicBgClass(value: string): string {
  return `league-page-bg--${value.slice(DYNAMIC_BG_PREFIX.length)}`;
}

/** 动态背景 key → 存储 value（"fx:meteor"）。 */
export function dynamicBackgroundValue(key: string): string {
  return `${DYNAMIC_BG_PREFIX}${key}`;
}

/** 校验 key 是否在动态背景白名单内。 */
export function isValidDynamicBackground(key: string): boolean {
  return DYNAMIC_BACKGROUNDS.some((item) => item.key === key);
}

/** 根据 value（如 "fx:meteor"）找动态背景定义；非动态或未知返回 null。 */
export function findDynamicBackground(value: string): DynamicBackground | null {
  if (!isDynamicBackground(value)) return null;
  const key = value.slice(DYNAMIC_BG_PREFIX.length);
  return DYNAMIC_BACKGROUNDS.find((item) => item.key === key) ?? null;
}
