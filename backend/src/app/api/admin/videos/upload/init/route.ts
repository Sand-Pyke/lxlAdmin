import { NextRequest, NextResponse } from 'next/server';
import { withApiErrors } from '@/server/api';
import { requireAdmin } from '@/server/auth';
import { initVideoUpload } from '@/server/videos';

export const dynamic = 'force-dynamic';

/** 开始分片上传（仅管理员）。body: { filename, size, chunkSize?, resumeUploadId? } */
export async function POST(request: NextRequest) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  return withApiErrors(async () => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await initVideoUpload(
      body.filename,
      body.size,
      body.chunkSize,
      body.resumeUploadId,
    );
    return NextResponse.json({ ok: true, ...result });
  });
}
