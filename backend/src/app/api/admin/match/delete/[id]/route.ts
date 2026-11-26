import { adminRoute, requiredId } from '@/server/api';

import { deleteMatch } from '@/server/admin';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ id: string }>(async ({ params, adminId }) =>
  deleteMatch(requiredId(params.id), adminId),
);
