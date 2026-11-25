'use client';

import {
  DeleteOutlined,
  InboxOutlined,
  PlayCircleFilled,
  PlusOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Space,
  Spin,
  Typography,
  Upload,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../components/draft/api-client';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import '../styles/videos.css';

type VideoItem = {
  id: number;
  title: string;
  description: string | null;
  size: number;
  created_at: string;
  url: string;
};

const dateText = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const time = date.toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `今天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleString('zh-CN', { month: 'long', day: 'numeric' })} ${time}`;
  }
  return `${date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })} ${time}`;
};

const formatSize = (bytes: number) => {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/** 分片上传参数。 */
const CHUNK_SIZE = 5 * 1024 * 1024;
const CHUNK_CONCURRENCY = 3;
const CHUNK_RETRIES = 3;
/** 服务端合并 + 转码要几分钟，这里轮询后台任务状态。 */
const JOB_POLL_INTERVAL_MS = 2000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

/** 服务端后台任务的阶段文案。 */
const PHASE_TEXT: Record<string, string> = {
  merging: '分片已上传完，正在合并…',
  transcoding: '正在转码优化视频，请稍候…',
  storing: '正在保存视频…',
};

type UploadHooks = {
  onProgress?: (percent: number) => void;
  /** 服务端后台任务的阶段；null 表示还没进入后台任务。 */
  onPhase?: (phase: string | null) => void;
  /** init 返回的会话 id，失败重试时用它续传，跳过已经传上去的分片。 */
  onUploadId?: (uploadId: string) => void;
};

const readJson = async (response: Response) =>
  (await response.json().catch(() => ({}))) as Record<string, unknown>;

const jobOf = (payload: Record<string, unknown>) =>
  (payload.job ?? null) as { phase?: string; error?: string } | null;

/**
 * 分片上传 + 断点续传：init → 并行上传分片（跳过服务端已有的）→ complete → 轮询后台转码任务。
 *
 * 上传统一走这条链路（即使配置了 OSS 也走）：分片才能给出进度、失败可以只重传出错的分片，
 * 而且服务端会把原始录屏转码成网页友好的 mp4，避免生产环境出现「上传完却播不了」。
 */
async function uploadVideoInChunks(
  file: File,
  title: string,
  description: string,
  resumeUploadId: string | null,
  hooks: UploadHooks,
) {
  const initResponse = await fetch('/api/admin/videos/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      chunkSize: CHUNK_SIZE,
      resumeUploadId,
    }),
  });
  const initData = await readJson(initResponse);
  if (!initResponse.ok) {
    throw new Error(String(initData.error || initData.msg || '初始化上传失败'));
  }

  const uploadId = String(initData.uploadId ?? '');
  const chunkSize = Number(initData.chunkSize) || CHUNK_SIZE;
  const chunkCount = Number(initData.chunkCount) || 0;
  if (!uploadId || chunkCount < 1) throw new Error('初始化上传失败');
  hooks.onUploadId?.(uploadId);

  // 断点续传：先查服务端已有的分片，避免重复上传。
  const statusResponse = await fetch(
    `/api/admin/videos/upload/status?uploadId=${encodeURIComponent(uploadId)}`,
  );
  const statusData = await readJson(statusResponse);
  const uploaded = new Set<number>(
    Array.isArray(statusData.uploaded) ? (statusData.uploaded as number[]) : [],
  );

  const report = () => hooks.onProgress?.(Math.round((uploaded.size / chunkCount) * 100));
  report();

  const uploadChunk = async (index: number) => {
    if (uploaded.has(index)) return;
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const blob = file.slice(start, end);
    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      const response = await fetch(
        `/api/admin/videos/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`,
        { method: 'PUT', body: blob },
      );
      if (response.ok) {
        uploaded.add(index);
        report();
        return;
      }
      const errorData = await readJson(response);
      if (attempt === CHUNK_RETRIES - 1) {
        throw new Error(String(errorData.error || errorData.msg || `分片 ${index + 1} 上传失败`));
      }
    }
  };

  // 并发窗口内并行上传；cursor 自增在同步段完成，多个 worker 不会取到同一分片。
  const pending = Array.from({ length: chunkCount }, (_, index) => index).filter(
    (index) => !uploaded.has(index),
  );
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, pending.length) }, async () => {
      while (cursor < pending.length) {
        const index = pending[cursor++];
        await uploadChunk(index);
      }
    }),
  );
  report();

  hooks.onPhase?.('merging');
  const completeResponse = await fetch('/api/admin/videos/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, title, description }),
  });
  const completeData = await readJson(completeResponse);
  if (!completeResponse.ok) {
    throw new Error(String(completeData.error || completeData.msg || '保存失败'));
  }

  // 合并 + 转码在服务端后台进行，轮询到终态为止。
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let job = jobOf(completeData);
  while (job?.phase !== 'done') {
    if (job?.phase === 'error') throw new Error(job.error || '视频处理失败，请重试');
    hooks.onPhase?.(job?.phase ?? 'merging');
    if (Date.now() > deadline) throw new Error('视频仍在后台转码，请稍后到视频列表查看');
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    const poll = await fetch(
      `/api/admin/videos/upload/status?uploadId=${encodeURIComponent(uploadId)}`,
    );
    const pollData = await readJson(poll);
    if (!poll.ok) throw new Error(String(pollData.error || pollData.msg || '读取上传进度失败'));
    job = jobOf(pollData);
    if (!job?.phase) throw new Error('读取上传进度失败');
  }
  hooks.onPhase?.(null);
}

/** 懒加载缩略图：进入视口前不发请求，避免列表页一次性拉取所有视频的元数据。 */
function VideoThumb({ url, title }: { url: string; title: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <video
      ref={ref}
      className="video-card__thumb"
      src={visible ? url : undefined}
      preload={visible ? 'metadata' : 'none'}
      muted
      playsInline
      aria-label={title}
    />
  );
}

/** 视频文件选择器：拖拽/点击选文件，由父组件持有 File 对象，不做自动上传。 */
function VideoFilePicker({
  value,
  onChange,
}: {
  value: File | null;
  onChange: (file: File | null) => void;
}) {
  return (
    <Upload.Dragger
      accept=".mp4,.webm,video/mp4,video/webm"
      maxCount={1}
      beforeUpload={() => false}
      onChange={(info) => {
        const last = info.fileList[info.fileList.length - 1];
        onChange((last?.originFileObj as File | undefined) ?? null);
      }}
      className="video-upload-dragger"
    >
      <p className="ant-upload-drag-icon">
        <InboxOutlined />
      </p>
      <p className="ant-upload-text">点击或拖拽视频到此处</p>
      <p className="ant-upload-hint">
        支持 mp4 / webm，单个不超过 200MB
        {value ? `（已选择：${value.name}，${formatSize(value.size)}）` : ''}
      </p>
    </Upload.Dragger>
  );
}

export default function Videos() {
  const { message } = App.useApp();
  const canManage = can(useViewer(), 'videos.manage');
  const [form] = Form.useForm();
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [playing, setPlaying] = useState<VideoItem | null>(null);
  /** 上一次上传的会话（同一文件失败重试时复用，跳过已上传的分片）。 */
  const uploadRef = useRef<{ key: string; id: string } | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);

  /** 分页读取视频：append 为 true 时把下一页追加到现有列表。 */
  const load = useCallback(async (targetPage: number, append: boolean) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    try {
      const response = await fetch(`/api/admin/videos?page=${targetPage}&pageSize=12`, {
        cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.msg || '读取视频列表失败');
      const items: VideoItem[] = Array.isArray(data.videos) ? data.videos : [];
      setVideos((prev) => (append ? [...prev, ...items] : items));
      setHasMore(Boolean(data.hasMore));
      setPage(targetPage);
    } catch (error) {
      message.error(errorText(error, '读取视频列表失败'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load(0, false);
  }, [load]);

  // 滚动加载下一页视频。
  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || loading || loadingMore || !hasMore) return;
    loadingMoreRef.current = true;
    void load(page + 1, true).finally(() => {
      loadingMoreRef.current = false;
    });
  }, [load, page, hasMore, loading, loadingMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  function openUpload() {
    setFile(null);
    setProgress(null);
    setPhase(null);
    uploadRef.current = null;
    form.resetFields();
    setUploadOpen(true);
  }

  async function submit() {
    const values = (await form.validateFields().catch(() => null)) as {
      title?: string;
      description?: string;
    } | null;
    if (!values || !file) return;
    setPending(true);
    setProgress(0);
    setPhase(null);
    try {
      const title = values.title ?? '';
      const description = values.description ?? '';
      // 同一个文件上一次失败过就沿用会话，跳过已经传上去的分片。
      const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
      const resumeUploadId = uploadRef.current?.key === fileKey ? uploadRef.current.id : null;

      await uploadVideoInChunks(file, title, description, resumeUploadId, {
        onProgress: setProgress,
        onPhase: setPhase,
        onUploadId: (uploadId) => {
          uploadRef.current = { key: fileKey, id: uploadId };
        },
      });

      uploadRef.current = null;
      message.success('视频已发布');
      setUploadOpen(false);
      setFile(null);
      setProgress(null);
      setPhase(null);
      form.resetFields();
      await load(0, false);
    } catch (error) {
      message.error(errorText(error, '上传失败'));
    } finally {
      setPending(false);
    }
  }

  async function remove(id: number) {
    setPending(true);
    try {
      const response = await fetch(`/api/admin/videos/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.msg || '删除失败');
      message.success('视频已删除');
      setVideos((items) => items.filter((item) => item.id !== id));
    } catch (error) {
      message.error(errorText(error, '删除失败'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card
      className="antd-panel video-gallery-card"
      title="比赛视频"
      extra={
        canManage ? (
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            disabled={pending}
            onClick={openUpload}
          >
            上传视频
          </Button>
        ) : null
      }
    >
      {loading ? (
        <div className="video-gallery-loading">
          <Spin />
        </div>
      ) : videos.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有视频，敬请期待比赛集锦" />
      ) : (
        <>
          <div className="video-grid">
            {videos.map((video) => (
              <article className="video-card" key={video.id}>
                <button
                  type="button"
                  className="video-card__cover"
                  aria-label={`播放视频：${video.title}`}
                  onClick={() => setPlaying(video)}
                >
                  <VideoThumb url={video.url} title={video.title} />
                  <span className="video-card__play" aria-hidden>
                    <PlayCircleFilled />
                  </span>
                </button>
                <div className="video-card__body">
                  <div className="video-card__title-row">
                    <span className="video-card__icon" aria-hidden>
                      <VideoCameraOutlined />
                    </span>
                    <Typography.Text className="video-card__title" ellipsis>
                      {video.title}
                    </Typography.Text>
                  </div>
                  {video.description ? (
                    <Typography.Paragraph className="video-card__desc" ellipsis={{ rows: 2 }}>
                      {video.description}
                    </Typography.Paragraph>
                  ) : null}
                  <div className="video-card__meta">
                    <Space size={10}>
                      <span>{dateText(video.created_at)}</span>
                      <span>{formatSize(video.size)}</span>
                    </Space>
                    {canManage ? (
                      <Popconfirm
                        title="删除这个视频？"
                        okText="确定"
                        cancelText="取消"
                        onConfirm={() => void remove(video.id)}
                      >
                        <Button
                          type="text"
                          danger
                          size="small"
                          icon={<DeleteOutlined />}
                          disabled={pending}
                        />
                      </Popconfirm>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
          {/* 滚动加载哨兵：进入视口前 400px 自动拉取下一页视频 */}
          <div ref={sentinelRef} className="videos-sentinel" aria-hidden="true" />
          {loadingMore ? (
            <div className="players-load-more">
              <Spin size="small" />
              <span>加载中…</span>
            </div>
          ) : !hasMore ? (
            <div className="players-load-more players-load-more--end">已加载全部视频</div>
          ) : null}
        </>
      )}

      {/* 播放弹窗：Plyr 播放器（中文文案 + 站点配色），全屏 / 倍速 / 画中画都自带。 */}
      <Modal
        className="video-player-modal"
        title={playing?.title}
        open={Boolean(playing)}
        footer={null}
        centered
        width="min(96vw, 1440px)"
        destroyOnHidden
        onCancel={() => setPlaying(null)}
      >
        {playing ? (
          <video
            src={playing.url}
            aria-label={playing.title}
            controls
            playsInline
            style={{ width: '100%', maxHeight: '70vh' }}
          />
        ) : null}
      </Modal>

      {/* 上传弹窗：自定义文件选择组件 + 标题简介表单。 */}
      <Modal
        title="上传视频"
        open={uploadOpen}
        okText="发布"
        cancelText="取消"
        confirmLoading={pending}
        onOk={() => void submit()}
        onCancel={() => setUploadOpen(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" className="video-upload-form">
          <Form.Item
            name="title"
            label="标题"
            rules={[
              { required: true, message: '请填写标题' },
              { max: 100, message: '标题不能超过 100 个字' },
            ]}
          >
            <Input placeholder="例如：S1 决赛精彩集锦" maxLength={100} showCount />
          </Form.Item>
          <Form.Item
            name="description"
            label="简介（可选）"
            rules={[{ max: 500, message: '简介不能超过 500 个字' }]}
          >
            <Input.TextArea
              placeholder="一句话介绍视频内容"
              maxLength={500}
              showCount
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Form.Item>
          <Form.Item label="视频文件" required>
            <VideoFilePicker value={file} onChange={setFile} />
          </Form.Item>
        </Form>
        {pending && progress !== null ? (
          <>
            <Progress
              percent={progress}
              status={progress === 100 && !phase ? 'success' : 'active'}
            />
            {phase ? (
              <Typography.Text type="secondary">
                {PHASE_TEXT[phase] ?? '正在处理视频…'}
              </Typography.Text>
            ) : null}
          </>
        ) : null}
      </Modal>
    </Card>
  );
}
