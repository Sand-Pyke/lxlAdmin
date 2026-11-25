import { listMatches } from '@/server/matches';
import { requireAdmin } from '@/server/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: import('next/server').NextRequest) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  return listMatches(request);
}
