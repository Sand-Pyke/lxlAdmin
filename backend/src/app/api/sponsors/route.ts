import { NextResponse } from 'next/server';
import { listSponsors } from '@/server/sponsors';
import { requireAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

/** 赞助榜只读：登录用户即可查看（新增/修改/移除仅核心管理员可操作）。 */
export async function GET(request: import('next/server').NextRequest) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  return NextResponse.json({ sponsors: await listSponsors() });
}
