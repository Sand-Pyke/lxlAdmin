import { coreAdminRoute } from '@/server/api';
import { adminAddSponsor, listSponsors } from '@/server/sponsors';

export const dynamic = 'force-dynamic';

export const GET = coreAdminRoute(async () => ({ sponsors: await listSponsors(true) }));

export const POST = coreAdminRoute(async ({ body }) => adminAddSponsor(body));
