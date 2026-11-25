import { changePassword } from '@/server/account';
import { requireAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: import('next/server').NextRequest) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  return changePassword(request);
}
