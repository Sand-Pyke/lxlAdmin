import { coreAdminRoute } from '@/server/api';
import { adminAddSponsor } from '@/server/sponsors';

export const dynamic = 'force-dynamic';

export const POST = coreAdminRoute(async ({ body }) => adminAddSponsor(body));
