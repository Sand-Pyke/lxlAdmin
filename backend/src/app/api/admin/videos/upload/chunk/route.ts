import { NextRequest, NextResponse } from 'next/server';
import { withApiErrors } from '@/server/api';
import { requireAdmin } from '@/server/auth';
import { uploadVideoChunk } from '@/server/videos';

export const dynamic = 'force-dynamic';

/** 上传单个分片（仅管理员）。query: uploadId, index；body 为分片二进制。 */
export async function PUT(request: NextRequest) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  return withApiErrors(async () => {
    const query = new URL(request.url).searchParams;
    const data = await request.arrayBuffer();
    const result = await uploadVideoChunk(query.get('uploadId'), query.get('index'), data);
    return NextResponse.json({ ok: true, ...result });
  });
}
