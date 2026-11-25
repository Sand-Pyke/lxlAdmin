import { NextRequest, NextResponse } from 'next/server';
import { withApiErrors } from '@/server/api';
import { requireAdmin } from '@/server/auth';
import { completeVideoUpload } from '@/server/videos';

export const dynamic = 'force-dynamic';

/** 提交发布（仅管理员）：校验分片齐全后启动后台合并/转码任务，进度用 status 接口轮询。body: { uploadId, title, description } */
export async function POST(request: NextRequest) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  return withApiErrors(async () => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await completeVideoUpload(body.uploadId, body.title, body.description);
    return NextResponse.json({ ok: true, ...result });
  });
}
