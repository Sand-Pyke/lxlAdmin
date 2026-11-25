import { adminRoute, requiredId } from '@/server/api';
import { discardPickDraft } from '@/server/admin';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ id: string }>(async ({ params, adminId }) =>
  discardPickDraft(requiredId(params.id), adminId),
);
