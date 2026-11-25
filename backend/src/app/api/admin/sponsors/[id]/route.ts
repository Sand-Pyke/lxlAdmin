import { coreAdminRoute } from '@/server/api';
import { adminRemoveSponsor, adminUpdateSponsor } from '@/server/sponsors';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute<{ id: string }>(async ({ params, body }) =>
  adminUpdateSponsor(Number(params.id), body),
);

export const DELETE = coreAdminRoute<{ id: string }>(async ({ params }) =>
  adminRemoveSponsor(Number(params.id)),
);
