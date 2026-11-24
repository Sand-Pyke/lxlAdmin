import type { User, Viewer } from '../api/types';
import { roleCapabilities } from './catalog.ts';
import type { AdminCapability, AdminRole } from './catalog.ts';

export type Permission = AdminCapability;
export function viewerRole(viewer: Viewer): AdminRole {
  if (!viewer.login || !viewer.is_admin) return 'USER';
  return viewer.is_core_admin
    ? 'CORE_ADMIN'
    : viewer.is_secondary_admin
      ? 'SECONDARY_ADMIN'
      : 'ADMIN';
}
export function can(viewer: Viewer, permission: Permission, target?: User): boolean {
  const ceiling = roleCapabilities(viewerRole(viewer));
  if (!ceiling.includes(permission)) return false;
  if (viewer.permissions && !viewer.permissions.includes(permission)) return false;
  if (!target) return true;
  if (!permission.startsWith('users.')) return true;
  const self = viewer.id === target.id || viewer.username === target.username;
  if (self) return false;
  if ((target.isAdmin || target.isSecondaryAdmin || target.isCoreAdmin) && !viewer.is_core_admin)
    return false;
  if (target.isCoreAdmin && ['users.review', 'users.ban', 'users.delete'].includes(permission))
    return false;
  return true;
}
export const MENU_PERMISSIONS: Record<string, Permission> = {
  '/draft': 'draft.view',
  '/': 'dashboard.view',
  '/users': 'users.view',
  '/matches': 'matches.view',
  '/signups': 'signups.view',
  '/seasons': 'seasons.view',
  '/markets': 'markets.view',
  '/shop': 'shop.view',
  '/recharge': 'points.recharge',
};
