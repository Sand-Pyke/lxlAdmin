import { adminRoute, requiredId } from '@/server/api';
import { setMatchStatus } from '@/server/admin';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ id: string }>(async ({ params, body, adminId }) =>
  setMatchStatus(requiredId(params.id), body.status, adminId),
);
