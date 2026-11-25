import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { assetRoot, safeAssetPath } from '@/lib/storage-paths';
import { serveUploadedImage, serveVideo } from '@/server/uploads';

export const dynamic = 'force-dynamic';
const types: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await context.params;
  const root = assetRoot();
  const file = safeAssetPath(root, segments);
  const type = file && types[path.extname(file).toLowerCase()];
  if (!file || !type) return new NextResponse('Not Found', { status: 404 });
  const info = await stat(file).catch(() => null);
  if (info?.isFile()) {
    const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!safeAssetPath(actualRoot, path.relative(actualRoot, actualFile).split(path.sep))) {
      return new NextResponse('Not Found', { status: 404 });
    }
    let start = 0;
    let end = info.size - 1;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return new NextResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${info.size}` },
        });
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (start > end || start >= info.size)
        return new NextResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${info.size}` },
        });
    }
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Content-Length': String(Math.max(0, end - start + 1)),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    if (info.size === 0) return new NextResponse(null, { headers });
    return new NextResponse(
      Readable.toWeb(createReadStream(actualFile, { start, end })) as ReadableStream<Uint8Array>,
      { status: range ? 206 : 200, headers },
    );
  }
  if (segments.length === 2) {
    const [kind, name] = segments;
    if (kind === 'videos') return serveVideo(name, request.headers.get('range'));
    if (
      kind === 'avatars' ||
      kind === 'user-bg' ||
      kind === 'shop-icons' ||
      kind === 'team-logos'
    ) {
      return serveUploadedImage(kind, name, new URL(request.url).searchParams.get('w'));
    }
  }
  return new NextResponse('Not Found', { status: 404 });
}
