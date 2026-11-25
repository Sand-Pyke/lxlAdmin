import { adminRoute } from '@/server/api';
import { listCommunityPosts } from '@/server/community';

export const dynamic = 'force-dynamic';
export const GET = adminRoute(async ({ query }) =>
  listCommunityPosts(Number(query.get('page')), Number(query.get('pageSize') ?? 10)),
);
