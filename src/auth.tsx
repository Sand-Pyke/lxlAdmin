import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { post } from './api/client';
import { loadSession } from './api/session';
import type { Viewer } from './api/types';

export const sessionKey = ['session'] as const;
export const sessionOptions = {
  queryKey: sessionKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => loadSession(signal),
  staleTime: 30_000,
  refetchInterval: 60_000,
  retry: false as const,
};
const Context = createContext<Viewer | null>(null);
export const useViewer = () => useContext(Context)!;
export function ViewerProvider({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  return <Context.Provider value={viewer}>{children}</Context.Provider>;
}
export function useSession() {
  const client = useQueryClient();
  useEffect(() => {
    const expire = () => {
      void client.invalidateQueries({ queryKey: sessionKey });
    };
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [client]);
  return useQuery(sessionOptions);
}
export async function login(username: string, password: string) {
  await post('/api/login', { username, password });
  const viewer = await loadSession();
  if (!viewer.login || !viewer.is_admin) {
    await post('/api/logout');
    throw new Error('该账号没有管理权限，请使用管理员账号登录');
  }
  return viewer;
}
export function roleLabel(viewer: Viewer) {
  return viewer.is_core_admin ? '核心管理员' : viewer.is_secondary_admin ? '二级管理员' : '管理员';
}
