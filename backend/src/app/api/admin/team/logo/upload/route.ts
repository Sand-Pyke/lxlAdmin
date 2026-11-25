import { NextRequest, NextResponse } from 'next/server';
import { withApiErrors } from '@/server/api';
import { requireCoreAdmin } from '@/server/auth';
import { uploadTeamLogo } from '@/server/season';

export const dynamic = 'force-dynamic';

/** 战队 Logo 上传（仅核心管理员），multipart 字段名 `logo`，返回可访问的图片路径。 */
export async function POST(request: NextRequest) {
  const { user, response } = await requireCoreAdmin(request);
  if (response) return response;
  return withApiErrors(async () => {
    const form = await request.formData().catch(() => null);
    const result = await uploadTeamLogo(user!.id, form?.get('logo'));
    return NextResponse.json({ ok: true, ...result });
  });
}
