import { adminRoute, badRequest, requiredId } from '@/server/api';

import { setUserRole } from '@/server/admin';

export const dynamic = 'force-dynamic';

const ROLES = ['CORE_ADMIN', 'SECONDARY_ADMIN', 'ADMIN', 'USER'] as const;
type Role = (typeof ROLES)[number];

export const POST = adminRoute(async ({ body, adminId }) => {
  const role = String(body.role ?? '');
  if (!ROLES.includes(role as Role)) throw badRequest('角色参数无效');
  return setUserRole(requiredId(body.userId), role as Role, adminId);
});
