/**
 * 上传 SVG 的安全清洗。
 *
 * SVG 是文本格式，可以内嵌脚本、事件属性与外链，因此在上传时先剥离这些
 * 可执行/可外联结构，再落库。清洗只做「移除危险内容」，其余原样保留，
 * 尽量不破坏图标的观感（fill/stroke/渐变/本地片段引用都保留）。
 */

const BLOCK_TAGS = 'script|foreignObject|iframe|object|embed';

/** 去掉 BOM 与首尾空白。 */
function normalizeInput(source: string) {
  return source.replace(/^\uFEFF/, '').trim();
}

function unquote(value: string) {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** 属性名不含 =<>"'` 与空白；值支持双引号/单引号/无引号三种写法。 */
const ANY_ATTR = /([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/g;

export function sanitizeSvg(source: string): string {
  let out = normalizeInput(source);

  // 文档类型声明：去掉以阻止实体声明与外部 DTD。
  out = out.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  // 注释。
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // 可执行 / 可嵌套活动内容整块删除。
  out = out.replace(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  out = out.replace(new RegExp(`<(${BLOCK_TAGS})\\b[^>]*\\/?>`, 'gi'), '');
  // 引用了外部资源的 <style> 块删除；本地片段与普通内联样式保留。
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (block) =>
    /@import|expression\s*\(|javascript:|vbscript:|url\s*\(\s*["']?(?!#)/i.test(block) ? '' : block,
  );
  // 除 <?xml ...?> 外的处理指令（如 <?xml-stylesheet ...?>）删除。
  out = out.replace(/<\?[^>]*\?>/g, '');
  // 事件处理器属性（onload/onclick/onbegin/…）。
  out = out.replace(/\son[a-z][\w:.-]*\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, '');
  // 任何属性值里出现 javascript:/vbscript: 协议即去掉该属性（含 SMIL values/to 等）。
  out = out.replace(ANY_ATTR, (match, name, quoted) =>
    /javascript:|vbscript:/i.test(unquote(quoted)) ? '' : match,
  );
  // 链接类属性只允许站内片段（#id）。
  out = out.replace(
    /\s(href|xlink:href|action|formaction|poster|background)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi,
    (match, name, quoted) => (unquote(quoted).startsWith('#') ? match : ''),
  );
  // src 只允许站内片段或内嵌图片。
  out = out.replace(/\s(src)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, (match, name, quoted) => {
    const value = unquote(quoted).toLowerCase();
    return value.startsWith('#') || value.startsWith('data:image/') ? match : '';
  });
  // style 属性里的外联资源 / 表达式删除；本地片段与普通填充样式保留。
  out = out.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, (match, quoted) =>
    /@import|expression\s*\(|javascript:|vbscript:|url\s*\(\s*["']?(?!#)/i.test(unquote(quoted))
      ? ''
      : match,
  );

  return out;
}

/** 是否看起来像一个 SVG 文档（允许带 <?xml?> 声明）。 */
export function looksLikeSvg(source: string) {
  const text = normalizeInput(source);
  return /^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>|\/)/i.test(text);
}
