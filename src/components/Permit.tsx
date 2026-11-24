import type { ReactNode } from 'react';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import type { Permission } from '../permissions/access';
export default function Permit({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  return can(useViewer(), permission) ? children : null;
}
