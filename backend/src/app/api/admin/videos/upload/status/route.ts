import { NextRequest, NextResponse } from 'next/server';
import { withApiErrors } from '@/server/api';
import { requireAdmin } from '@/server/auth';
import { videoUploadStatus } from '@/server/videos';

export const dynamic = 'force-dynamic';

/** 查询上传进度（仅管理员）：已上传的分片序号 + 后台发布任务阶段，供断点续传与轮询。query: uploadId */
export async function GET(request: NextRequest) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  return withApiErrors(async () => {
    const query = new URL(request.url).searchParams;
    const result = await videoUploadStatus(query.get('uploadId'));
    return NextResponse.json({ ok: true, ...result });
  });
}
