/** 固定尺寸档位让相同素材尽量复用浏览器和 OSS 缓存，覆盖两倍屏。 */
export const IMAGE_WIDTHS = [64, 128, 256, 384, 512] as const;

export function thumbnailWidth(value: unknown): number | undefined {
  const width = Number(value);
  return IMAGE_WIDTHS.some((size) => size === width) ? width : undefined;
}

/** 只处理本站上传路径；外部图片、默认 SVG 头像与带签名 URL 原样保留。 */
export function imageThumbnail(src: string | undefined, displaySize: number): string | undefined {
  if (
    !src ||
    !/^\/assets\/(shop-icons|avatars|team-logos)\/[uts]\d+(?:_\d+)?\.(?:jpg|jpeg|png|gif|webp)(?:\?|$)/i.test(
      src,
    )
  )
    return src;
  const url = new URL(src, 'http://local.invalid');
  const target = displaySize * 2;
  const width = IMAGE_WIDTHS.find((size) => size >= target) ?? 512;
  url.searchParams.set('w', String(width));
  return `${url.pathname}${url.search}${url.hash}`;
}
