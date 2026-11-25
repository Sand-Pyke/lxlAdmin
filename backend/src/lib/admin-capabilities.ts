/** The permission contract for the independent admin app. Business handlers still enforce target and state rules. */
export const ADMIN_CAPABILITIES = [
  'dashboard.view',
  'users.view',
  'users.review',
  'users.game_name.update',
  'users.rank.update',
  'users.ban',
  'users.unban',
  'users.role.assign',
  'users.delete',
  'users.password.reset',
  'matches.view',
  'matches.create',
  'draft.view',
  'draft.control',
  'draft.reset',
  'draft.finish',
  'signups.view',
  'signups.cancel',
  'signups.season.cancel',
  'seasons.view',
  'videos.manage',
  'community.moderate',
  'signups.position',
  'markets.view',
  'markets.open',
  'markets.close',
  'markets.settle',
  'markets.void',
  'shop.view',
  'shop.create',
  'shop.update',
  'shop.delete',
  'shop.upload',
  'points.recharge',
  'sponsors.manage',
] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];
export type AdminRole = 'USER' | 'ADMIN' | 'SECONDARY_ADMIN' | 'CORE_ADMIN';
type Actor = {
  id: number;
  username: string;
  isAdmin: boolean;
  isSecondaryAdmin: boolean;
  isCoreAdmin: boolean;
};
const BASE: AdminCapability[] = [
  'dashboard.view',
  'users.view',
  'users.review',
  'users.game_name.update',
  'matches.view',
  'matches.create',
  'draft.view',
  'draft.control',
  'draft.reset',
  'draft.finish',
  'signups.view',
  'seasons.view',
  'videos.manage',
  'community.moderate',
  'signups.position',
];
export function adminRole(
  actor: Pick<Actor, 'isAdmin' | 'isSecondaryAdmin' | 'isCoreAdmin'>,
): AdminRole {
  if (!actor.isAdmin) return 'USER';
  return actor.isCoreAdmin ? 'CORE_ADMIN' : actor.isSecondaryAdmin ? 'SECONDARY_ADMIN' : 'ADMIN';
}
export function roleCapabilities(role: AdminRole): AdminCapability[] {
  if (role === 'USER') return [];
  if (role === 'CORE_ADMIN') return [...ADMIN_CAPABILITIES];
  return role === 'SECONDARY_ADMIN'
    ? [...BASE, 'users.rank.update', 'users.ban', 'users.unban', 'signups.cancel']
    : [...BASE];
}
export function adminCapabilitySnapshot(actor: Actor) {
  const role = adminRole(actor);
  return {
    version: 1,
    user_id: actor.id,
    username: actor.username,
    role,
    permissions: roleCapabilities(role),
  };
}
