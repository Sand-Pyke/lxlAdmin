import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/server/auth';
import { adminCapabilitySnapshot } from '@/lib/admin-capabilities';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { user, response } = await requireAdmin(request);
  if (response) return response;
  return NextResponse.json(
    { ok: true, ...adminCapabilitySnapshot(user!) },
    {
      headers: { 'Cache-Control': 'no-store, private' },
    },
  );
}
