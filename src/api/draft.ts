import { ApiError, request } from './client.ts';
export const LEGACY_MUSIC_TRACKS = [
  { name: 'Prelude to Battle', src: '/assets/music/Prelude%20to%20Battle.mp3' },
  { name: 'Way Too Long', src: '/assets/music/Way%20Too%20Long.mp3' },
];
export async function loadDraftMusic(signal?: AbortSignal) {
  try {
    return await request<{ tracks: { name: string; src: string }[] }>('/api/admin/draft/music', {
      signal,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { tracks: LEGACY_MUSIC_TRACKS };
    throw error;
  }
}
