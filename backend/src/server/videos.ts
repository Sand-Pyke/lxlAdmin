import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prisma } from '@/lib/prisma';
import { ApiError, badRequest, notFound } from '@/server/api';
import {
  deleteStoredObject,
  putStoredObject,
  putStoredObjectFromFile,
  uploadDir,
} from '@/server/uploads';

/**
 * 视频内容模块（最小可用版）：仅管理员上传比赛集锦等官方内容，
 * 原始 mp4/webm 直接存 OSS（或本地磁盘回退），前端 `<video>` 直接播放。
 */

const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB ?? 200);
const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024;

const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const toDto = (video: {
  id: number;
  title: string;
  description: string | null;
  objectKey: string;
  size: number;
  createdAt: Date;
}) => ({
  id: video.id,
  title: video.title,
  description: video.description,
  size: video.size,
  created_at: video.createdAt.toISOString(),
  url: `/assets/videos/${video.objectKey.split('/').pop() ?? ''}`,
});

/** 真实文件头校验：mp4 看 ftyp 盒子，webm 看 EBML 魔数。 */
function isRealVideo(buffer: Buffer, ext: string) {
  const head = buffer.subarray(0, 16);
  if (ext === '.mp4') return head.subarray(4, 8).toString('latin1') === 'ftyp';
  if (ext === '.webm') {
    return (
      head.length >= 4 &&
      head[0] === 0x1a &&
      head[1] === 0x45 &&
      head[2] === 0xdf &&
      head[3] === 0xa3
    );
  }
  return false;
}

const execFileAsync = promisify(execFile);

const ffmpegBin = () => process.env.FFMPEG_PATH?.trim() || 'ffmpeg';

/**
 * 把任意 mp4/webm 重编码成网页友好的 mp4：
 * H.264 + yuv420p + AAC + faststart（moov 前置秒开）+ 30fps 恒定帧率 + 1080p 封顶。
 * 输出码率由 CRF 23 控制，通常远小于录屏/游戏录像原片，弱网下也能流畅播放。
 */
export async function transcodeToWebMp4(inputPath: string, outputPath: string) {
  await execFileAsync(ffmpegBin(), [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-vf',
    "scale='min(1920,iw)':-2",
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputPath,
  ]);
}

const VIDEO_PAGE_SIZE = 12;
const VIDEO_PAGE_MAX = 60;

export async function listVideos(page = 0, pageSize = VIDEO_PAGE_SIZE) {
  const safePage = Math.max(0, Math.trunc(page) || 0);
  const safeSize = Math.min(Math.max(Math.trunc(pageSize) || VIDEO_PAGE_SIZE, 1), VIDEO_PAGE_MAX);
  const [total, videos] = await Promise.all([
    prisma.video.count(),
    prisma.video.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: safePage * safeSize,
      take: safeSize,
    }),
  ]);
  return {
    videos: videos.map(toDto),
    total,
    hasMore: (safePage + 1) * safeSize < total,
  };
}

export async function addVideo(title: unknown, description: unknown, file: unknown) {
  const name = asText(title);
  if (!name) throw badRequest('标题不能为空');
  if (name.length > 100) throw badRequest('标题不能超过 100 个字');
  const desc = asText(description);
  if (desc.length > 500) throw badRequest('简介不能超过 500 个字');
  if (!(file instanceof File) || !file.name) throw badRequest('请选择视频文件');
  const ext = path.extname(file.name).toLowerCase();
  const mimeType = VIDEO_TYPES[ext];
  if (!mimeType) throw badRequest('仅支持 mp4/webm 视频');
  if (file.size > MAX_VIDEO_BYTES) {
    throw new ApiError(400, `视频不能超过 ${MAX_VIDEO_MB}MB`);
  }
  if (file.size === 0) throw badRequest('视频文件为空');
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!isRealVideo(buffer, ext)) throw badRequest('文件不是有效的 mp4/webm 视频');

  const objectName = `v${Date.now()}_${randomBytes(4).toString('hex')}${ext}`;
  await putStoredObject('videos', objectName, buffer, mimeType);
  try {
    const video = await prisma.video.create({
      data: {
        title: name.slice(0, 100),
        description: desc || null,
        objectKey: `videos/${objectName}`,
        mimeType,
        size: file.size,
      },
    });
    return toDto(video);
  } catch (error) {
    // 数据库写入失败时回收刚上传的对象，避免留下孤儿文件。
    await deleteStoredObject('videos', objectName).catch(() => undefined);
    throw error;
  }
}

export async function deleteVideo(id: number) {
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) throw notFound('视频不存在');
  await prisma.video.delete({ where: { id } });
  const name = video.objectKey.split('/').pop() ?? '';
  if (name) await deleteStoredObject('videos', name).catch(() => undefined);
}

/* ------------------------------- 分片上传 ------------------------------- */

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE = 20 * 1024 * 1024;
/** 未完成的分片会话超过该时长会被视为废弃并清理。 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_ID = /^[a-f0-9]{32}$/;

type UploadSession = {
  uploadId: string;
  filename: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  objectName: string;
  ext: string;
  mimeType: string;
  createdAt: number;
};

/** 发布流水线的阶段：前端据此显示进度文案，done/error 为终态。 */
type JobPhase = 'merging' | 'transcoding' | 'storing' | 'done' | 'error';

type UploadJob = {
  phase: JobPhase;
  /** 失败原因（已转成可直接展示给管理员的文案）。 */
  error?: string;
  /** 发布成功后的视频信息。 */
  video?: ReturnType<typeof toDto>;
  updatedAt: number;
};

const JOB_PHASES: readonly JobPhase[] = ['merging', 'transcoding', 'storing', 'done', 'error'];

function videoTmpRoot() {
  return path.join(uploadDir('videos'), '.tmp');
}

function sessionDir(uploadId: string) {
  return path.join(videoTmpRoot(), uploadId);
}

function sessionFile(uploadId: string) {
  return path.join(sessionDir(uploadId), 'session.json');
}

function partFile(uploadId: string, index: number) {
  return path.join(sessionDir(uploadId), `${index}.part`);
}

function jobFile(uploadId: string) {
  return path.join(sessionDir(uploadId), 'job.json');
}

function expectedChunkSize(session: UploadSession, index: number) {
  const start = index * session.chunkSize;
  return Math.min(session.chunkSize, session.size - start);
}

async function readSession(uploadId: string): Promise<UploadSession | null> {
  if (!UPLOAD_ID.test(uploadId)) return null;
  try {
    const raw = await readFile(sessionFile(uploadId), 'utf8');
    const session = JSON.parse(raw) as UploadSession;
    if (
      typeof session.size !== 'number' ||
      session.size < 1 ||
      typeof session.chunkSize !== 'number' ||
      typeof session.chunkCount !== 'number' ||
      !session.objectName
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** 读取后台发布任务状态；文件不存在或内容异常时返回 null。 */
async function readJob(uploadId: string): Promise<UploadJob | null> {
  if (!UPLOAD_ID.test(uploadId)) return null;
  try {
    const job = JSON.parse(await readFile(jobFile(uploadId), 'utf8')) as UploadJob;
    return job && JOB_PHASES.includes(job.phase) ? job : null;
  } catch {
    return null;
  }
}

/** 写入任务状态：只用于给前端展示，写失败不抛错、也不影响发布流程。 */
async function writeJob(uploadId: string, job: Omit<UploadJob, 'updatedAt'>) {
  const payload = JSON.stringify({ ...job, updatedAt: Date.now() });
  await mkdir(sessionDir(uploadId), { recursive: true }).catch(() => undefined);
  await writeFile(jobFile(uploadId), payload, 'utf8').catch(() => undefined);
}

/** 清理过期未完成的分片会话，避免残留占用磁盘（失败静默，不影响主流程）。 */
async function sweepStaleSessions() {
  const root = videoTmpRoot();
  const names = await readdir(root).catch(() => [] as string[]);
  const now = Date.now();
  await Promise.all(
    names.map(async (name) => {
      if (!UPLOAD_ID.test(name)) return;
      const dir = path.join(root, name);
      const info = await stat(dir).catch(() => null);
      if (info && now - info.mtimeMs > SESSION_TTL_MS) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }),
  );
}

/**
 * 开始一次分片上传：生成会话与目标文件名，返回分片参数。
 *
 * `resumeUploadId` 用于上传/转码失败后的重试：同一个文件、尚未发布成功的会话会被复用，
 * 前端随后按 /status 里已存在的分片跳过重传。
 */
export async function initVideoUpload(
  filename: unknown,
  size: unknown,
  chunkSize?: unknown,
  resumeUploadId?: unknown,
) {
  const name = asText(filename);
  if (!name) throw badRequest('请选择视频文件');
  const ext = path.extname(name).toLowerCase();
  const mimeType = VIDEO_TYPES[ext];
  if (!mimeType) throw badRequest('仅支持 mp4/webm 视频');
  const sizeNum = Number(size);
  if (!Number.isInteger(sizeNum) || sizeNum < 1 || sizeNum > MAX_VIDEO_BYTES) {
    throw new ApiError(400, `视频大小无效（上限 ${MAX_VIDEO_MB}MB）`);
  }
  const resume = asText(resumeUploadId);
  if (resume) {
    const session = await readSession(resume);
    const job = session ? await readJob(session.uploadId) : null;
    const reusable =
      session && session.filename === name && session.size === sizeNum && job?.phase !== 'done';
    if (reusable) {
      return {
        uploadId: session.uploadId,
        chunkSize: session.chunkSize,
        chunkCount: session.chunkCount,
      };
    }
  }

  const requested = Number(chunkSize);
  const chunk =
    Number.isInteger(requested) && requested >= 1 && requested <= MAX_CHUNK_SIZE
      ? requested
      : DEFAULT_CHUNK_SIZE;
  const uploadId = randomBytes(16).toString('hex');
  // 最终统一转码为 mp4，目标文件名固定用 .mp4（原始 ext 仅用于上传时的文件头校验）。
  const objectName = `v${Date.now()}_${randomBytes(4).toString('hex')}.mp4`;
  const session: UploadSession = {
    uploadId,
    filename: name,
    size: sizeNum,
    chunkSize: chunk,
    chunkCount: Math.ceil(sizeNum / chunk),
    objectName,
    ext,
    mimeType,
    createdAt: Date.now(),
  };
  const dir = sessionDir(uploadId);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionFile(uploadId), JSON.stringify(session), 'utf8');
  void sweepStaleSessions();
  return { uploadId, chunkSize: chunk, chunkCount: session.chunkCount };
}

/** 上传单个分片：字节数必须与预期一致，先写临时文件再原子改名。 */
export async function uploadVideoChunk(uploadId: unknown, index: unknown, data: ArrayBuffer) {
  const session = await readSession(asText(uploadId));
  if (!session) throw badRequest('上传会话不存在或已过期，请重新上传');
  const chunkIndex = Number(index);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.chunkCount) {
    throw badRequest('分片序号无效');
  }
  const expected = expectedChunkSize(session, chunkIndex);
  if (data.byteLength !== expected) {
    throw badRequest(`分片大小不正确（应为 ${expected} 字节）`);
  }
  const target = partFile(session.uploadId, chunkIndex);
  const temp = `${target}.tmp`;
  await writeFile(temp, Buffer.from(data));
  await rename(temp, target);
  return { index: chunkIndex, uploaded: data.byteLength };
}

/** 查询已上传的分片序号，供前端断点续传时跳过。 */
export async function videoUploadStatus(uploadId: unknown) {
  const session = await readSession(asText(uploadId));
  if (!session) throw badRequest('上传会话不存在或已过期，请重新上传');
  const uploaded: number[] = [];
  for (let index = 0; index < session.chunkCount; index++) {
    const info = await stat(partFile(session.uploadId, index)).catch(() => null);
    if (info && info.size === expectedChunkSize(session, index)) uploaded.push(index);
  }
  return { chunkCount: session.chunkCount, uploaded, job: await readJob(session.uploadId) };
}

/** 正在处理中的上传会话（进程内去重，避免同一个 uploadId 被并发触发多次转码）。 */
const runningJobs = new Set<string>();

/** 后台发布任务：拼分片 → 校验文件头 → 转码 → 写入存储（OSS 或本地磁盘）→ 落库。 */
async function publishVideo(session: UploadSession, title: string, description: string) {
  const dir = sessionDir(session.uploadId);
  // 中间产物放在会话目录里：与视频数据目录同盘，成功后直接改名落地。
  const rawPath = path.join(dir, 'source.raw');
  const outputPath = path.join(dir, session.objectName);
  try {
    await mergeParts(session, rawPath);
    // 只读前 16 字节校验真实文件头，避免为校验把整段读进内存。
    if (!isRealVideo(await readHead(rawPath), session.ext)) {
      // 拼出来的文件不是视频：分片内容不可信，清掉让重试时重新上传。
      await clearParts(session);
      throw new Error('文件不是有效的 mp4/webm 视频');
    }

    // 统一转码成网页友好的 mp4（H.264 + faststart + 恒定帧率 + 1080p 封顶），解决卡顿与起播慢。
    await writeJob(session.uploadId, { phase: 'transcoding' });
    try {
      await transcodeToWebMp4(rawPath, outputPath);
    } catch {
      throw new Error('视频转码失败，请确认文件完整后重试');
    }
    await rm(rawPath, { force: true }).catch(() => undefined);

    await writeJob(session.uploadId, { phase: 'storing' });
    const size = await putStoredObjectFromFile(
      'videos',
      session.objectName,
      outputPath,
      'video/mp4',
    );

    const video = await prisma.video.create({
      data: {
        title: title.slice(0, 100),
        description: description || null,
        objectKey: `videos/${session.objectName}`,
        mimeType: 'video/mp4',
        size,
      },
    });
    await writeJob(session.uploadId, { phase: 'done', video: toDto(video) });
    await clearParts(session);
  } catch (error) {
    // 失败时保留分片：用同一个 uploadId 重试即可，不必重传几百兆。
    await rm(rawPath, { force: true }).catch(() => undefined);
    await rm(outputPath, { force: true }).catch(() => undefined);
    await writeJob(session.uploadId, {
      phase: 'error',
      error: error instanceof Error ? error.message : '视频处理失败，请重试',
    });
  }
}

/** 按分片序号顺序流式拼接成原始文件（不整段读进内存）。 */
async function mergeParts(session: UploadSession, targetPath: string) {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(targetPath, { flags: 'w' });
    output.on('finish', resolve);
    output.on('error', reject);
    void (async () => {
      try {
        for (let index = 0; index < session.chunkCount; index++) {
          await new Promise<void>((done, fail) => {
            const input = createReadStream(partFile(session.uploadId, index));
            input.on('error', fail);
            input.on('end', done);
            input.pipe(output, { end: false });
          });
        }
        output.end();
      } catch (error) {
        output.destroy();
        reject(error);
      }
    })();
  });
}

/** 读文件头若干字节，用于校验真实格式而不是只看扩展名。 */
async function readHead(filePath: string, bytes = 16) {
  return new Promise<Buffer>((resolve, reject) => {
    const input = createReadStream(filePath, { start: 0, end: bytes - 1 });
    const pieces: Buffer[] = [];
    input.on('data', (piece) => pieces.push(piece as Buffer));
    input.on('end', () => resolve(Buffer.concat(pieces)));
    input.on('error', reject);
  });
}

/** 发布成功后只清掉分片，保留 session.json / job.json 供前端取最终结果。 */
async function clearParts(session: UploadSession) {
  await Promise.all(
    Array.from({ length: session.chunkCount }, (_, index) =>
      rm(partFile(session.uploadId, index), { force: true }).catch(() => undefined),
    ),
  );
}

/**
 * 提交发布：只校验分片是否齐全，然后启动后台任务并立即返回。
 *
 * 合并 + 转码一个 200MB 的视频可能要几分钟，放在请求里会被反向代理的读超时打断
 * （表现为「进度卡住后报上传失败」），所以转码放进后台，前端改用 /status 轮询。
 */
export async function completeVideoUpload(uploadId: unknown, title: unknown, description: unknown) {
  const session = await readSession(asText(uploadId));
  if (!session) throw badRequest('上传会话不存在或已过期，请重新上传');
  const name = asText(title);
  if (!name) throw badRequest('标题不能为空');
  if (name.length > 100) throw badRequest('标题不能超过 100 个字');
  const desc = asText(description);
  if (desc.length > 500) throw badRequest('简介不能超过 500 个字');

  // 已经在处理或已经发布成功时直接回当前状态，不重复启动任务。
  const existing = await readJob(session.uploadId);
  if (existing?.phase === 'done') return { uploadId: session.uploadId, job: existing };
  if (existing && existing.phase !== 'error') return { uploadId: session.uploadId, job: existing };

  for (let index = 0; index < session.chunkCount; index++) {
    const info = await stat(partFile(session.uploadId, index)).catch(() => null);
    if (!info || info.size !== expectedChunkSize(session, index)) {
      throw badRequest(`分片 ${index + 1}/${session.chunkCount} 缺失，请重新上传`);
    }
  }

  if (!runningJobs.has(session.uploadId)) {
    runningJobs.add(session.uploadId);
    await writeJob(session.uploadId, { phase: 'merging' });
    void publishVideo(session, name, desc).finally(() => runningJobs.delete(session.uploadId));
  }
  const job = await readJob(session.uploadId);
  return {
    uploadId: session.uploadId,
    job: job ?? { phase: 'merging' as const, updatedAt: Date.now() },
  };
}
