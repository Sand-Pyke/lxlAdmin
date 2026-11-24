import { ApiError, request } from './client.ts';
import type { Viewer } from './types';
import { roleCapabilities } from '../permissions/catalog.ts';
import { viewerRole } from '../permissions/access.ts';

type Snapshot = {
  version: number;
  user_id: number;
  username: string;
  role: string;
  permissions: string[];
};
export async function loadSession(signal?: AbortSignal): Promise<Viewer> {
  const viewer = await request<Viewer>('/api/current_user', { signal });
  if (!viewer.login || !viewer.is_admin) return viewer;
  try {
    const snapshot = await request<Snapshot>('/api/admin/permissions', { signal });
    if (
      snapshot.version !== 1 ||
      snapshot.username !== viewer.username ||
      !Number.isInteger(snapshot.user_id) ||
      !Array.isArray(snapshot.permissions) ||
      !snapshot.permissions.every((value) => typeof value === 'string')
    ) {
      throw new Error('权限数据格式异常，请重新登录或刷新后重试');
    }
    return {
      ...viewer,
      id: snapshot.user_id,
      permissions: snapshot.permissions,
      permissionSource: 'server',
    };
  } catch (error) {
    // Only an explicitly missing endpoint can use the legacy role mapping. Denials/outages never increase permissions.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return {
      ...viewer,
      permissions: roleCapabilities(viewerRole(viewer)),
      permissionSource: 'legacy',
    };
  }
}
