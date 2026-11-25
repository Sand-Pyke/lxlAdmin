import path from 'node:path';

/** Shared media catalogue, independently mounted; never proxied through the user website. */
export function assetRoot() {
  return process.env.ASSET_DIR
    ? path.resolve(process.env.ASSET_DIR)
    : path.join(process.cwd(), 'public', 'assets');
}

export function safeAssetPath(root: string, segments: string[]) {
  if (
    !segments.length ||
    segments.some((part) => !part || part.startsWith('.') || /[\\/\0]/.test(part))
  )
    return null;
  const target = path.resolve(root, ...segments);
  const relative = path.relative(path.resolve(root), target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : target;
}
