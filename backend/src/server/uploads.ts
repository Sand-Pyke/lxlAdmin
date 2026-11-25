import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import OSS from 'ali-oss';
import { ossEnabled, ossEndpoint } from '@/lib/oss-endpoint';
import { assetRoot } from '@/lib/storage-paths';
import { thumbnailWidth } from '@/lib/image-thumbnail';
import { createImageDelivery, IMAGE_KINDS, type ImageKind } from '@/server/image-delivery';

/**
 * 选手上传的图片（头像、自定义背景）。
 *
 * 存储策略：配置了 OSS 环境变量时直接写入阿里云 OSS，应用不再依赖本地磁盘；
 * 未配置时回退到 UPLOAD_DIR（默认 <cwd>/data/uploads）本地落盘，开发环境零配置可用。
 *
 * 读取链路（/assets/avatars/*、/assets/user-bg/*）对两种存储都兼容：
 * 1. 配置了 OSS_PUBLIC_BASE_URL（Bucket 开通公网读）时 307 直跳 OSS，省应用带宽；
 * 2. 否则应用从 OSS 取对象读回字节流（私读 Bucket 也能用）；
 * 3. 文件不在 OSS 时继续兜底本地数据目录与 public/ 里的历史文件。
 * 因此数据库里现有的 /assets/... 路径完全不用迁移。
 */

export type UploadKind = 'avatars' | 'user-bg' | 'team-logos' | 'shop-icons' | 'videos';

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export const IMAGE_EXTS: readonly string[] = Object.keys(IMAGE_TYPES);

export function imageContentType(nameOrExt: string) {
  return IMAGE_TYPES[path.extname(nameOrExt).toLowerCase()];
}

/** 上传文件本地落盘目录；容器里通过 UPLOAD_DIR 指向挂载出来的数据目录。 */
export function uploadDir(kind: UploadKind) {
  const root = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(process.cwd(), 'data', 'uploads');
  return path.join(root, kind);
}

/** 历史上传文件曾经落在 public/ 下，这里只做只读兜底。 */
function legacyDir(kind: UploadKind) {
  return path.join(assetRoot(), kind);
}

/** 只接受 `u<用户ID>_<时间戳>.<后缀>` 与旧命名 `u<用户ID>.<后缀>`，战队 Logo 的
 * `t<管理员ID>_<时间戳>.<后缀>`，以及商城图标的 `s<管理员ID>_<时间戳>.<后缀>`，
 * 杜绝目录穿越与任意文件读取。 */
const FILE_NAME = /^[uts]\d+(_\d+)?\.(jpg|jpeg|png|gif|webp|svg)$/;

/* ------------------------------- OSS 存储 ------------------------------- */

let oss: OSS | null = null;
// 复用同一素材的存在性检查（包括同时出现的多个头像框），避免逐图 HEAD 往返。
const objectChecks = new Map<string, { expires: number; result: Promise<boolean> }>();

/** 惰性创建 OSS 客户端；未配置时返回 null（回退本地磁盘）。 */
export function ossClient() {
  if (!ossEnabled()) return null;
  if (!oss) {
    // OSS_ENDPOINT 可选：填了就覆盖默认公网域名（内网 endpoint、自定义域名）。
    const endpoint = ossEndpoint();
    oss = new OSS({
      region: process.env.OSS_REGION!,
      bucket: process.env.OSS_BUCKET!,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
      secure: true,
      timeout: 120_000,
      retryMax: 3,
      ...(endpoint ? { endpoint } : {}),
    });
  }
  return oss;
}

/** OSS 对象 Key：可选 OSS_PREFIX 前缀 + `<kind>/<文件名>`。 */
function ossKey(kind: UploadKind, name: string) {
  const prefix = process.env.OSS_PREFIX?.replace(/^\/+|\/+$/g, '') ?? '';
  return prefix ? `${prefix}/${kind}/${name}` : `${kind}/${name}`;
}

let imageDelivery: ReturnType<typeof createImageDelivery> | null = null;

function getImageDelivery() {
  if (!imageDelivery) {
    imageDelivery = createImageDelivery({
      storage: ossClient,
      sign: (key) => ossClient()?.signatureUrl(key, { expires: 3600 }) ?? '',
      publicUrl: (key) => {
        const publicBase = process.env.OSS_PUBLIC_BASE_URL?.replace(/\/+$/, '');
        return publicBase ? `${publicBase}/${key.replace(/^\/+/, '')}` : null;
      },
      objectKey: (kind, name) => ossKey(kind as UploadKind, name),
      uploadRoot: () =>
        process.env.UPLOAD_DIR
          ? path.resolve(process.env.UPLOAD_DIR)
          : path.join(process.cwd(), 'data', 'uploads'),
      publicRoot: assetRoot(),
    });
  }
  return imageDelivery;
}

export function warmUploadedImage(kind: ImageKind, name: string) {
  getImageDelivery().warm(kind, name);
}

export function invalidateUploadedImage(kind: ImageKind, name: string) {
  getImageDelivery().invalidate(kind, name);
}

/**
 * 写入一个存储对象（图片/视频通用）：配置了 OSS 就直传，否则落本地磁盘。
 */
export async function putStoredObject(
  kind: UploadKind,
  name: string,
  buffer: Buffer,
  contentType: string,
) {
  const client = ossClient();
  if (client) {
    await client.put(ossKey(kind, name), buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
    objectChecks.delete(ossKey(kind, name));
  } else {
    const dir = uploadDir(kind);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), buffer);
  }
  if (IMAGE_KINDS.includes(kind as ImageKind)) {
    const imageKind = kind as ImageKind;
    invalidateUploadedImage(imageKind, name);
    warmUploadedImage(imageKind, name);
  }
}

/** 图片上传入口（语义别名，保持调用方可读性）。 */
export const putUploadedImage = putStoredObject;

/**
 * 从本地文件写入一个存储对象（视频这类大文件专用）：OSS 走分片上传，
 * 本地磁盘则直接把文件搬进数据目录。返回落盘字节数。
 */
export async function putStoredObjectFromFile(
  kind: UploadKind,
  name: string,
  filePath: string,
  contentType: string,
) {
  const info = await stat(filePath);
  const client = ossClient();
  if (client) {
    await client.multipartUpload(ossKey(kind, name), filePath, {
      parallel: 2,
      partSize: 10 * 1024 * 1024,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
    await rm(filePath, { force: true }).catch(() => undefined);
    return info.size;
  }
  const dir = uploadDir(kind);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  try {
    await rename(filePath, target);
  } catch {
    // 极端情况下转码目录与数据目录不在同一个文件系统，退回逐字节复制。
    await copyFile(filePath, target);
    await rm(filePath, { force: true }).catch(() => undefined);
  }
  return info.size;
}

/** 删除一个存储对象：OSS 或本地磁盘，失败静默（清理场景不阻塞主流程）。 */
export async function deleteStoredObject(kind: UploadKind, name: string) {
  objectChecks.delete(ossKey(kind, name));
  const client = ossClient();
  if (client) {
    await client.delete(ossKey(kind, name)).catch(() => undefined);
  } else {
    await unlink(path.join(uploadDir(kind), name)).catch(() => undefined);
  }
  if (IMAGE_KINDS.includes(kind as ImageKind)) {
    invalidateUploadedImage(kind as ImageKind, name);
  }
}

/** OSS 上是否已存在该文件（用于公网直跳前的存在性检查）。 */
async function ossHasObject(key: string) {
  const client = ossClient();
  if (!client) return false;
  const cached = objectChecks.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (objectChecks.size >= 512) objectChecks.delete(objectChecks.keys().next().value!);
  const entry = { expires: Date.now() + 60_000, result: Promise.resolve(false) };
  entry.result = client
    .head(key)
    .then(() => true)
    .catch(() => {
      entry.expires = Date.now() + 5_000;
      return false;
    });
  objectChecks.set(key, entry);
  return entry.result;
}

/** 同一个人的旧图片只留一张：删除 OSS 或本地目录里属于该用户的历史文件。 */
export async function removeOldUploads(
  kind: UploadKind,
  keep: string,
  isOwn: (name: string) => boolean,
) {
  const client = ossClient();
  if (client) {
    const names: string[] = [];
    let marker: string | undefined;
    do {
      const result = await client.list({ prefix: ossKey(kind, ''), marker, 'max-keys': 1000 }, {});
      for (const object of result.objects ?? []) {
        const name = object.name.split('/').pop() ?? '';
        if (name !== keep && FILE_NAME.test(name) && isOwn(name)) names.push(name);
      }
      marker = result.nextMarker || undefined;
    } while (marker);
    await Promise.all(
      names.map((name) => client.delete(ossKey(kind, name)).catch(() => undefined)),
    );
    return;
  }
  const dir = uploadDir(kind);
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name !== keep && isOwn(name))
      .map((name) => unlink(path.join(dir, name)).catch(() => undefined)),
  );
}

function uploadedImageProcess(kind: UploadKind, name: string, requestedWidth?: number) {
  const width = thumbnailWidth(requestedWidth) ?? (kind === 'user-bg' ? 1920 : 256);
  // SVG 是矢量图，不需要栅格化缩略图。
  if (path.extname(name).toLowerCase() === '.svg') return null;
  // GIF 不加 quality/auto-orient，也不转换为静态 WebP，保留全部动画帧。
  if (path.extname(name).toLowerCase() === '.gif') {
    return requestedWidth ? `image/resize,m_lfit,w_${width},h_${width},limit_1/format,gif` : null;
  }
  return `image/resize,w_${width}/format,webp/quality,q_80`;
}

/** 读取一张上传图片：OSS 优先，再兜底本地数据目录与 public/ 里的历史文件。 */
export async function readUploadedImage(kind: UploadKind, name: string, width?: number) {
  if (!FILE_NAME.test(name)) return null;
  const contentType = imageContentType(name);
  if (!contentType) return null;
  const client = ossClient();
  if (client) {
    const process = uploadedImageProcess(kind, name, thumbnailWidth(width));
    let result = await client.get(ossKey(kind, name), process ? { process } : {}).catch(() => null);
    let processed = Boolean(process && result?.content);
    if (!result?.content && process) {
      result = await client.get(ossKey(kind, name)).catch(() => null);
      processed = false;
    }
    if (result?.content) {
      return {
        buffer: Buffer.from(result.content),
        contentType: processed && contentType !== 'image/gif' ? 'image/webp' : contentType,
      };
    }
  }
  for (const dir of [uploadDir(kind), legacyDir(kind)]) {
    const buffer = await readFile(path.join(dir, name)).catch(() => null);
    if (buffer) return { buffer, contentType };
  }
  return null;
}

/** 文件名带毫秒时间戳，每次上传都会变，可以放心长缓存。 */
export async function serveUploadedImage(kind: UploadKind, name: string, requestedWidth?: unknown) {
  if (!IMAGE_KINDS.includes(kind as ImageKind)) {
    return new NextResponse('Not Found', { status: 404 });
  }
  return getImageDelivery().serve(kind as ImageKind, name, requestedWidth);
}

/* ------------------------------- 视频读取 ------------------------------- */

/** 视频文件名：`v<时间戳>_<随机串>.(mp4|webm)`，与图片规则一样杜绝目录穿越。 */
const VIDEO_NAME = /^v\d+_[a-f0-9]+\.(mp4|webm)$/;

function videoContentType(name: string) {
  return name.endsWith('.webm') ? 'video/webm' : 'video/mp4';
}

type VideoSource = {
  total: number;
  /** 读取 [start, end] 字节区间的 Web 流。 */
  readRange: (start: number, end: number) => ReadableStream<Uint8Array>;
};

/** 本地磁盘的视频源：按 Range 用文件流直接吐字节，不整段缓冲进内存。 */
async function resolveLocalVideoSource(name: string): Promise<VideoSource | null> {
  const filePath = path.join(uploadDir('videos'), name);
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) return null;
  return {
    total: info.size,
    readRange: (start, end) =>
      Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>,
  };
}

function rangeNotSatisfiable(total: number) {
  return new NextResponse('Range Not Satisfiable', {
    status: 416,
    headers: { 'Content-Range': `bytes */${total}` },
  });
}

/** 解析 `Range: bytes=start-end`（仅支持单段），返回 [start, end]，非法时抛 416。 */
function parseRange(rangeHeader: string, total: number): [number, number] | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) throw rangeNotSatisfiable(total);
  const [, startText, endText] = match;
  if (startText === '' && endText === '') throw rangeNotSatisfiable(total);
  if (startText === '') {
    // 后缀范围：取最后 N 字节。
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw rangeNotSatisfiable(total);
    const start = Math.max(total - suffix, 0);
    return [start, total - 1];
  }
  const start = Number(startText);
  const end = endText === '' ? total - 1 : Math.min(Number(endText), total - 1);
  if (!Number.isSafeInteger(start) || start >= total || end < start) {
    throw rangeNotSatisfiable(total);
  }
  return [start, end];
}

/** 视频播放：支持 Range 分段拉流（HTML5 video 拖动进度条依赖它）。 */
export async function serveVideo(name: string, rangeHeader: string | null) {
  if (!VIDEO_NAME.test(name)) return new NextResponse('Not Found', { status: 404 });
  const client = ossClient();
  if (client) {
    const key = ossKey('videos', name);
    if (await ossHasObject(key)) {
      const publicBase = process.env.OSS_PUBLIC_BASE_URL?.replace(/\/+$/, '');
      if (publicBase) return NextResponse.redirect(`${publicBase}/${key}`, 307);
      // 私有 Bucket：签发带有效期的签名 URL，307 直跳 OSS，让浏览器与 OSS 直接协商 Range，
      // 避免每个 Range 分片都经应用中转、并把整段字节缓冲进内存。
      const signedUrl = client.signatureUrl(key, { expires: 3600 });
      return NextResponse.redirect(signedUrl, 307);
    }
  }
  const source = await resolveLocalVideoSource(name);
  if (!source) return new NextResponse('Not Found', { status: 404 });

  const contentType = videoContentType(name);
  const common = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };

  let range: [number, number];
  try {
    const parsed = parseRange(rangeHeader ?? '', source.total);
    range = parsed ?? [0, source.total - 1];
  } catch (error) {
    return error as NextResponse;
  }

  const [start, end] = range;
  return new NextResponse(await source.readRange(start, end), {
    status: rangeHeader ? 206 : 200,
    headers: {
      ...common,
      'Content-Length': String(end - start + 1),
      ...(rangeHeader ? { 'Content-Range': `bytes ${start}-${end}/${source.total}` } : {}),
    },
  });
}
