import { coreAdminRoute, requiredId } from '@/server/api';

import { deleteMatch } from '@/server/admin';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute<{ id: string }>(async ({ params, adminId }) =>
  deleteMatch(requiredId(params.id), adminId),
);
