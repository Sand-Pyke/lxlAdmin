/** 内置头像框：直接引用随代码发布的 SVG，不创建上传副本。 */
export const AVATAR_FRAMES = [
  { value: 'gold', label: '经典金色（CSS）', image: '' },
  {
    value: '/assets/avatar-frames/cosmic-ring.svg',
    label: '星河光环',
    image: '/assets/avatar-frames/cosmic-ring.svg',
  },
  {
    value: '/assets/avatar-frames/cyber-hex.svg',
    label: '赛博六芒',
    image: '/assets/avatar-frames/cyber-hex.svg',
  },
  {
    value: '/assets/avatar-frames/frost-crystal.svg',
    label: '冰霜晶冠',
    image: '/assets/avatar-frames/frost-crystal.svg',
  },
  {
    value: '/assets/avatar-frames/mecha-core.svg',
    label: '机甲核心',
    image: '/assets/avatar-frames/mecha-core.svg',
  },
  {
    value: '/assets/avatar-frames/molten-crown.svg',
    label: '熔岩王冠',
    image: '/assets/avatar-frames/molten-crown.svg',
  },
  {
    value: '/assets/avatar-frames/thorn-rose.svg',
    label: '荆棘玫瑰',
    image: '/assets/avatar-frames/thorn-rose.svg',
  },
  {
    value: '/assets/avatar-frames/solar-laurel.svg',
    label: '曜金月桂',
    image: '/assets/avatar-frames/solar-laurel.svg',
  },
  {
    value: '/assets/avatar-frames/lunar-eclipse.svg',
    label: '银月星蚀',
    image: '/assets/avatar-frames/lunar-eclipse.svg',
  },
  {
    value: '/assets/avatar-frames/tide-pearl.svg',
    label: '沧海明珠',
    image: '/assets/avatar-frames/tide-pearl.svg',
  },
  {
    value: '/assets/avatar-frames/jade-dragon.svg',
    label: '翡翠龙鳞',
    image: '/assets/avatar-frames/jade-dragon.svg',
  },
  {
    value: '/assets/avatar-frames/storm-sigil.svg',
    label: '雷霆刻印',
    image: '/assets/avatar-frames/storm-sigil.svg',
  },
  {
    value: '/assets/avatar-frames/phoenix-feather.svg',
    label: '焰羽重生',
    image: '/assets/avatar-frames/phoenix-feather.svg',
  },
  {
    value: '/assets/avatar-frames/sakura-bloom.svg',
    label: '绯樱流光',
    image: '/assets/avatar-frames/sakura-bloom.svg',
  },
  {
    value: '/assets/avatar-frames/obsidian-aegis.svg',
    label: '玄曜战盾',
    image: '/assets/avatar-frames/obsidian-aegis.svg',
  },
  {
    value: '/assets/avatar-frames/celestial-compass.svg',
    label: '星航罗盘',
    image: '/assets/avatar-frames/celestial-compass.svg',
  },
  {
    value: '/assets/avatar-frames/royal-amethyst.svg',
    label: '紫晶王权',
    image: '/assets/avatar-frames/royal-amethyst.svg',
  },
  {
    value: '/assets/avatar-frames/cosmic-vortex.svg',
    label: '星涡巡航 · 动态',
    animated: true,
    image: '/assets/avatar-frames/cosmic-vortex.svg',
  },
  {
    value: '/assets/avatar-frames/lightning-reactor.svg',
    label: '雷霆反应炉 · 动态',
    animated: true,
    image: '/assets/avatar-frames/lightning-reactor.svg',
  },
  {
    value: '/assets/avatar-frames/solar-flare.svg',
    label: '日冕耀斑 · 动态',
    animated: true,
    image: '/assets/avatar-frames/solar-flare.svg',
  },
  {
    value: '/assets/avatar-frames/aurora-prism.svg',
    label: '极光棱镜 · 动态',
    animated: true,
    image: '/assets/avatar-frames/aurora-prism.svg',
  },
] as const;

export function findAvatarFrame(value: string) {
  return AVATAR_FRAMES.find((frame) => frame.value === value);
}
