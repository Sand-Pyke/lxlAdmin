import type { ShopItem } from './types';
import { AVATAR_FRAMES } from '../data/avatar-frames.ts';
import { NAMEPLATE_STYLES } from '../data/nameplates.ts';

export const SHOP_CATEGORIES = [
  { value: 'AVATAR_FRAME', label: '头像框' },
  { value: 'TITLE', label: '称号' },
  { value: 'NAMEPLATE', label: '铭牌' },
  { value: 'BACKGROUND', label: '背景' },
  { value: 'ITEM_CARD', label: '道具卡' },
];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INT = 2_147_483_647;
export type ShopForm = {
  category: string;
  name: string;
  icon: string;
  description: string;
  price: number | null;
  durationDays: number | null;
  stock: number | null;
  enabled: boolean;
  eligibleMinUserId: number | null;
  eligibleMaxUserId: number | null;
  avatarFrameStyle: string;
  effectValue: string;
  dynamicBg: string;
};
export function imageSource(value?: string) {
  if (!value) return '';
  if (value.startsWith('/assets/') && !value.includes('..')) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? value
      : '';
  } catch {
    return '';
  }
}
export function validateShopImage(file: { name: string; size: number }) {
  if (!/\.(jpe?g|png|gif|webp|svg)$/i.test(file.name))
    throw new Error('仅支持 JPG、PNG、GIF、WebP、SVG 图片');
  if (file.size <= 0) throw new Error('请选择非空图片');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 5MB');
}
export function shopFormValues(item?: ShopItem): ShopForm {
  const defaults: ShopForm = {
    category: 'AVATAR_FRAME',
    name: '',
    icon: '',
    description: '',
    price: null,
    durationDays: null,
    stock: null,
    enabled: true,
    eligibleMinUserId: null,
    eligibleMaxUserId: null,
    avatarFrameStyle: 'gold',
    effectValue: '',
    dynamicBg: '',
  };
  if (!item) return defaults;
  let effect: { type?: string; value?: string } = {};
  try {
    effect = JSON.parse(item.effectJson || '{}');
  } catch {
    /* Preserve other fields if legacy effect JSON is malformed. */
  }
  const value = typeof effect?.value === 'string' ? effect.value : '';
  return {
    ...defaults,
    category: item.category,
    name: item.name,
    icon: item.icon || '',
    description: item.description || '',
    price: item.price,
    durationDays: item.durationDays,
    stock: item.stock,
    enabled: item.enabled,
    eligibleMinUserId: item.eligibleMinUserId,
    eligibleMaxUserId: item.eligibleMaxUserId,
    avatarFrameStyle:
      item.category === 'AVATAR_FRAME'
        ? AVATAR_FRAMES.find((frame) => frame.value === value)?.value || ''
        : '',
    effectValue:
      item.category === 'NAMEPLATE'
        ? NAMEPLATE_STYLES.some((style) => style.value === value)
          ? value
          : 'custom'
        : item.category === 'TITLE'
          ? value
          : '',
    dynamicBg: item.category === 'BACKGROUND' && value.startsWith('fx:') ? value.slice(3) : '',
    ...(['BACKGROUND', 'NAMEPLATE', 'AVATAR_FRAME'].includes(item.category) && imageSource(value)
      ? { icon: value }
      : {}),
  };
}
function nullableInteger(value: number | null | undefined, min: number, name: string) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < min || value > MAX_INT)
    throw new Error(`${name}必须是不小于 ${min} 的整数`);
  return value;
}
export function shopPayload(values: ShopForm, editing?: ShopItem) {
  const category = editing?.category || values.category;
  if (
    !SHOP_CATEGORIES.some((item) => item.value === category) &&
    !(editing && category === 'THEME')
  )
    throw new Error('请选择有效商品分类');
  const name = values.name?.trim();
  if (!name) throw new Error('请填写商品名称');
  const price = nullableInteger(values.price, 0, '价格');
  if (price === null) throw new Error('请填写价格');
  const min = nullableInteger(values.eligibleMinUserId, 1, '领取起始名次');
  const max = nullableInteger(values.eligibleMaxUserId, 1, '领取截止名次');
  if (min !== null && max !== null && min > max) throw new Error('领取起始名次不能大于截止名次');
  if (price === 0 && min === null && max === null) throw new Error('免费商品必须设置领取资格范围');
  const durationDays = nullableInteger(values.durationDays, 1, '有效期');
  const icon = values.icon?.trim() || '';
  const body: Record<string, unknown> = {
    name,
    price,
    icon,
    description: values.description?.trim() || '',
    durationDays,
    eligibleMinUserId: min,
    eligibleMaxUserId: max,
  };
  // Never send code/effectType/effectJson/groupCode or change a live item's category.
  if (!editing) body.category = category;
  if (editing) {
    body.stock = nullableInteger(values.stock, 0, '库存');
    body.enabled = values.enabled;
  }
  if (category === 'AVATAR_FRAME') {
    body.avatarFrameStyle = values.avatarFrameStyle || '';
    if (!values.avatarFrameStyle && !imageSource(icon)) throw new Error('自定义头像框请先上传图片');
  }
  if (category === 'NAMEPLATE') {
    body.effectValue = values.effectValue || 'champion';
    if (body.effectValue === 'custom' && !imageSource(icon))
      throw new Error('自定义铭牌请先上传横幅图片');
  }
  if (category === 'TITLE') body.effectValue = values.effectValue?.trim() || '';
  if (category === 'BACKGROUND') {
    body.dynamicBg = values.dynamicBg || '';
    if (!values.dynamicBg && !imageSource(icon)) throw new Error('请选择动态背景或上传背景图片');
  }
  return body;
}
