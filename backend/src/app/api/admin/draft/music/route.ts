import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/server/auth';
import { draftMusicTracks } from '@/lib/draft-music';
import { assetRoot } from '@/lib/storage-paths';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const { response } = await requireAdmin(request);
  if (response) return response;
  const files = await readdir(path.join(assetRoot(), 'music'), {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return NextResponse.json(
    { ok: true, tracks: draftMusicTracks(files) },
    { headers: { 'Cache-Control': 'no-store, private' } },
  );
}
