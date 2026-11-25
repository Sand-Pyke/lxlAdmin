import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type OSS from 'ali-oss';
import { IMAGE_WIDTHS, thumbnailWidth } from '@/lib/image-thumbnail';

export const IMAGE_KINDS = ['avatars', 'user-bg', 'team-logos', 'shop-icons'] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
const FILE_NAME = /^[uts]\d+(_\d+)?\.(jpg|jpeg|png|gif|webp|svg)$/;
const CAPTAIN_TEAM_LOGO_NAME = /^m\d+_u\d+_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(jpg|jpeg|png|gif|webp|svg)$/;

export function isUploadedImageName(kind: ImageKind | 'videos', name: string) {
  return FILE_NAME.test(name) || (kind === 'team-logos' && CAPTAIN_TEAM_LOGO_NAME.test(name));
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const immutableName = (name: string) => /_\d+\./.test(name);
const mime = (name: string) =>
  name.endsWith('.svg')
    ? 'image/svg+xml'
    : name.endsWith('.gif')
      ? 'image/gif'
      : name.endsWith('.webp')
        ? 'image/webp'
        : /\.png$/.test(name)
          ? 'image/png'
          : 'image/jpeg';
type Source = { version: string; file?: string; key?: string };
type Options = {
  storage: () => OSS | null;
  sign: (key: string) => string;
  publicUrl: (key: string) => string | null;
  objectKey: (kind: ImageKind, name: string) => string;
  uploadRoot: () => string;
  publicRoot: string;
};

/** A bounded preparation queue, shared by foreground requests and optional warm-up. */
export function createImageDelivery(options: Options) {
  const sources = new Map<string, { until: number; value: Promise<Source | null> }>();
  const jobs = new Map<string, Promise<{ file?: string; key?: string; type: string }>>();
  const queue: { id: string; run: () => void }[] = [];
  let running = 0;
  let lastPrune = 0;
  const cacheRoot = () => path.join(options.uploadRoot(), '.image-cache', 'v2');
  const pump = () => {
    if (running < 1) queue.shift()?.run();
  };

  async function resolve(kind: ImageKind, name: string): Promise<Source | null> {
    const id = `${kind}/${name}`;
    const previous = sources.get(id);
    if (previous && previous.until > Date.now()) return previous.value;
    if (sources.size >= 512) sources.delete(sources.keys().next().value!);
    const value = (async () => {
      // Public files already win over the legacy dynamic URL; keep their content authoritative.
      const local = path.join(options.publicRoot, kind, name);
      const info = await stat(local).catch(() => null);
      if (info?.isFile()) return { file: local, version: `${info.size}:${info.mtimeMs}` };
      const storage = options.storage();
      if (storage) {
        const key = options.objectKey(kind, name);
        try {
          const head = await storage.head(key, { timeout: 8000 });
          return {
            key,
            version: head.res.headers.etag || head.res.headers['last-modified'] || name,
          };
        } catch (error) {
          // Network/authentication failures are not cached as a missing object.
          if ((error as { status?: number }).status !== 404) throw error;
        }
      }
      const file = path.join(options.uploadRoot(), kind, name);
      const uploaded = await stat(file).catch(() => null);
      return uploaded?.isFile() ? { file, version: `${uploaded.size}:${uploaded.mtimeMs}` } : null;
    })();
    sources.set(id, { until: Date.now() + 60_000, value });
    try {
      return await value;
    } catch (error) {
      sources.delete(id);
      throw error;
    }
  }

  async function prune() {
    if (Date.now() - lastPrune < 3600_000) return;
    lastPrune = Date.now();
    const root = cacheRoot();
    const files = (await readdir(root).catch(() => [])).filter((name) =>
      /^[a-f0-9]{64}\.(gif|webp)$/.test(name),
    );
    const entries = await Promise.all(
      files.map(async (name) => ({
        file: path.join(root, name),
        info: await stat(path.join(root, name)).catch(() => null),
      })),
    );
    entries.sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0));
    let bytes = 0;
    for (const entry of entries) {
      bytes += entry.info?.size ?? 0;
      if (bytes > 256 * 1024 * 1024) await unlink(entry.file).catch(() => undefined);
    }
  }

  function prepare(
    kind: ImageKind,
    name: string,
    source: Source,
    width: number,
    foreground: boolean,
  ) {
    const id = digest(`${kind}/${name}:${source.version}:${width}:v2`);
    const existing = jobs.get(id);
    if (existing) {
      if (foreground) {
        const index = queue.findIndex((job) => job.id === id);
        if (index > 0) queue.unshift(queue.splice(index, 1)[0]);
      }
      return existing;
    }
    const type = name.endsWith('.gif') ? 'image/gif' : 'image/webp';
    const extension = type === 'image/gif' ? 'gif' : 'webp';
    const result = new Promise<{ file?: string; key?: string; type: string }>(
      (resolveJob, reject) => {
        const job = {
          id,
          run: () => {
            running++;
            void (async () => {
              if (source.file) {
                const file = path.join(cacheRoot(), `${id}.${extension}`);
                if (!(await stat(file).catch(() => null))) {
                  const image = sharp(source.file, {
                    animated: true,
                    limitInputPixels: 64_000_000,
                  }).resize({ width, height: width, fit: 'inside', withoutEnlargement: true });
                  const buffer = await (
                    extension === 'gif' ? image.gif() : image.rotate().webp({ quality: 80 })
                  ).toBuffer();
                  await mkdir(cacheRoot(), { recursive: true });
                  const temporary = `${file}.${process.pid}.tmp`;
                  await writeFile(temporary, buffer);
                  await rename(temporary, file);
                  void prune().catch(() => undefined);
                }
                return { file, type };
              }
              const storage = options.storage()!;
              const key = options.objectKey(kind, `.thumbs/v2/${id}.${extension}`);
              try {
                await storage.head(key, { timeout: 8000 });
                return { key, type };
              } catch (error) {
                if ((error as { status?: number }).status !== 404) throw error;
              }
              // Offload animation decoding to OSS instead of consuming the web process's memory.
              const processImage =
                extension === 'gif'
                  ? `image/resize,m_lfit,w_${width},h_${width},limit_1/format,gif`
                  : `image/auto-orient,1/resize,m_lfit,w_${width},h_${width},limit_1/format,webp/quality,q_80`;
              const transformed = await storage.get(source.key!, {
                process: processImage,
                timeout: 20000,
              });
              const buffer = Buffer.from(transformed.content);
              if (!buffer.length || buffer.length > 20 * 1024 * 1024)
                throw new Error('Invalid image derivative');
              await storage.put(key, buffer, {
                headers: {
                  'Content-Type': type,
                  'Cache-Control': 'public, max-age=31536000, immutable',
                },
              });
              return { key, type };
            })()
              .then(resolveJob, reject)
              .finally(() => {
                running--;
                jobs.delete(id);
                pump();
              });
          },
        };
        if (foreground) queue.unshift(job);
        else queue.push(job);
      },
    );
    jobs.set(id, result);
    pump();
    return result;
  }

  async function serve(kind: ImageKind, name: string, requestedWidth?: unknown): Promise<Response> {
    if (!isUploadedImageName(kind, name)) return new Response('Not Found', { status: 404 });
    const width = thumbnailWidth(requestedWidth);
    if (requestedWidth != null && requestedWidth !== '' && !width)
      return new Response('Invalid image size', { status: 400 });
    const started = performance.now();
    try {
      const source = await resolve(kind, name);
      if (!source)
        return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      const resolvedAt = performance.now();
      let output: { file?: string; key?: string; type: string } = {
        file: source.file,
        key: source.key,
        type: mime(name),
      };
      let fallback = false;
      // SVG 是矢量图，直接返回原文件，不做栅格化缩略图。
      if (width && !name.endsWith('.svg')) {
        try {
          output = await prepare(kind, name, source, width, true);
        } catch {
          fallback = true;
        }
      }
      const timing = `source;dur=${(resolvedAt - started).toFixed(1)},variant;dur=${(performance.now() - resolvedAt).toFixed(1)}`;
      if (output.key) {
        const publicUrl = options.publicUrl(output.key);
        const location = publicUrl || options.sign(output.key);
        return new Response(null, {
          status: 307,
          headers: {
            Location: location,
            'Cache-Control': fallback
              ? 'no-store'
              : publicUrl && immutableName(name)
                ? 'public, max-age=86400'
                : 'public, max-age=300',
            'Server-Timing': timing,
            'X-Image-Variant': fallback ? 'original-fallback' : width ? 'stored' : 'original',
          },
        });
      }
      const buffer = await readFile(output.file!);
      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': output.type,
          'Content-Length': String(buffer.length),
          'Cache-Control': fallback
            ? 'no-store'
            : immutableName(name)
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=300',
          'Server-Timing': timing,
          'X-Image-Variant': fallback ? 'original-fallback' : width ? 'stored' : 'original',
        },
      });
    } catch {
      return new Response('Image temporarily unavailable', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
      });
    }
  }

  function warm(kind: ImageKind, name: string, widths: readonly number[] = [128, 384]) {
    if (!isUploadedImageName(kind, name) || queue.length >= 32 || name.endsWith('.svg')) return;
    void (async () => {
      const source = await resolve(kind, name);
      if (!source) return;
      for (const width of widths) {
        if (!IMAGE_WIDTHS.includes(width as (typeof IMAGE_WIDTHS)[number]) || queue.length >= 32)
          continue;
        await prepare(kind, name, source, width, false);
      }
    })().catch(() => undefined);
  }
  function invalidate(kind: ImageKind, name: string) {
    sources.delete(`${kind}/${name}`);
  }
  return { serve, warm, invalidate };
}
