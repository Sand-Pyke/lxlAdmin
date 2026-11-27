/** 报名铭牌：内置设计与后台上传的横幅共用一套展示和校验。 */
export const NAMEPLATES = [
  { value: 'champion', label: '冠军之冠', image: '/assets/nameplates/champion.svg', price: 80 },
  { value: 'neon', label: '峡谷霓虹', image: '/assets/nameplates/neon.svg', price: 60 },
  { value: 'orbit', label: '星轨徽章', image: '/assets/nameplates/orbit.svg', price: 60 },
  { value: 'crimson', label: '赤焰王冠', image: '/assets/nameplates/crimson.svg', price: 1999 },
  { value: 'aurora', label: '极光冰晶', image: '/assets/nameplates/aurora.svg', price: 1999 },
  { value: 'jade', label: '翡翠长生', image: '/assets/nameplates/jade.svg', price: 1999 },
  { value: 'storm', label: '雷霆苍穹', image: '/assets/nameplates/storm.svg', price: 1999 },
  { value: 'phoenix', label: '烬凰归途', image: '/assets/nameplates/phoenix.svg', price: 1999 },
  { value: 'royal', label: '紫金王座', image: '/assets/nameplates/royal.svg', price: 1999 },
] as const;

/** 动态款供后台选用，不自动生成默认商品，售价与上架由管理员设置。 */
export const ANIMATED_NAMEPLATES = [
  {
    value: 'void-jump',
    label: '深空跃迁 · 动态',
    image: '/assets/nameplates/void-jump.svg',
    animated: true,
  },
  {
    value: 'crimson-eclipse',
    label: '赤月刃痕 · 动态',
    image: '/assets/nameplates/crimson-eclipse.svg',
    animated: true,
  },
  {
    value: 'holo-terminal',
    label: '全息终端 · 动态',
    image: '/assets/nameplates/holo-terminal.svg',
    animated: true,
  },
  {
    value: 'ink-leviathan',
    label: '墨海游鲲 · 动态',
    image: '/assets/nameplates/ink-leviathan.svg',
    animated: true,
  },
] as const;

export const NAMEPLATE_STYLES = [...NAMEPLATES, ...ANIMATED_NAMEPLATES] as const;

// These templates are uploaded as shop images so existing user clients can render them.
export const SHOP_NAMEPLATE_PRESETS = [
  ['black-dragon', '黑曜龙息'],
  ['volt-crown', '电弧王冠'],
  ['obsidian-samurai', '烬夜鬼面'],
  ['gravity-rift', '引力裂隙'],
  ['glacier-javelin', '冰狱长锋'],
  ['solar-forge', '熔日铸心'],
  ['neon-overdrive', '霓城超频'],
  ['jade-tempest', '苍玉风暴'],
  ['chrome-sentinel', '银翼哨兵'],
  ['violet-scythe', '虚刃残月'],
].map(([id, name]) => ({
  value: `template:${id}`,
  label: `${name} · 动态`,
  name: `铭牌·${name}`,
  filename: `${id}.svg`,
  image: `/nameplate-presets/${id}.svg`,
}));

export function isAnimatedNameplate(value: string) {
  return ANIMATED_NAMEPLATES.some((plate) => plate.value === value || plate.image === value);
}

export function nameplateImage(value: string) {
  const preset = NAMEPLATE_STYLES.find((item) => item.value === value);
  if (preset) return preset.image;
  if (/^\/assets\/(shop-icons|nameplates)\/[a-zA-Z0-9._/-]+$/.test(value) && !value.includes('..'))
    return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    /* Unknown values render as the default row. */
  }
  return '';
}

export function nameplateValue(effectJson: string) {
  try {
    const effect = JSON.parse(effectJson) as { type?: unknown; value?: unknown };
    return effect.type === 'nameplate' &&
      typeof effect.value === 'string' &&
      nameplateImage(effect.value)
      ? effect.value
      : '';
  } catch {
    return '';
  }
}
