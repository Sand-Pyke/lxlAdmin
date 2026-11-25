import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Alert, Button, Result, Spin } from 'antd';
import { Navigate, Outlet, Route, Routes, useLocation, useParams, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSession, ViewerProvider, useViewer } from './auth';
import Shell from './components/Shell';
import Login from './pages/Login';
import { can, MENU_PERMISSIONS } from './permissions/access';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Users = lazy(() => import('./pages/Users'));
const Matches = lazy(() => import('./pages/Matches'));
const Signups = lazy(() => import('./pages/Signups'));
const Seasons = lazy(() => import('./pages/Seasons'));
const Shop = lazy(() => import('./pages/Shop'));
const Markets = lazy(() => import('./pages/Markets'));
const Recharge = lazy(() => import('./pages/Recharge'));
const Draft = lazy(() => import('./pages/Draft'));
const DraftLineup = lazy(() => import('./pages/DraftLineup'));
const MatchManage = lazy(() => import('./pages/MatchManage'));
const SeasonManage = lazy(() => import('./pages/SeasonManage'));
const Sponsors = lazy(() => import('./pages/Sponsors'));
const Videos = lazy(() => import('./pages/Videos'));
const Community = lazy(() => import('./pages/Community'));
function Loading() {
  return (
    <div className="loading-page">
      <Spin size="large" />
      <p>正在加载管理平台…</p>
    </div>
  );
}
function RetiredAuction() {
  const { id = '' } = useParams();
  return (
    <Result
      status="info"
      title="大屏选人 2.0 已停用"
      subTitle="请使用 1.0 大屏选人。"
      extra={
        <Link to={`/draft/${id}`}>
          <Button type="primary">进入大屏选人</Button>
        </Link>
      }
    />
  );
}
function PermissionGate({ core = false }: { core?: boolean }) {
  const session = useSession();
  const location = useLocation();
  const client = useQueryClient();
  useEffect(() => {
    if (session.data && (!session.data.login || !session.data.is_admin)) {
      void client.cancelQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    }
  }, [session.data, client]);
  if (session.isPending) return <Loading />;
  if (session.error)
    return (
      <div className="connection-error">
        <Alert
          showIcon
          type="error"
          title="暂时无法验证登录状态"
          description={session.error.message}
          action={<Button onClick={() => void session.refetch()}>重新连接</Button>}
        />
      </div>
    );
  if (!session.data?.login || !session.data.is_admin)
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  if (core && !session.data.is_core_admin)
    return (
      <Result
        status="403"
        title="暂无管理权限"
        subTitle="当前账号没有该模块的访问权限。"
        extra={<Button href="/">返回工作台</Button>}
      />
    );
  return (
    <ViewerProvider viewer={session.data}>
      <Outlet />
    </ViewerProvider>
  );
}
function ModuleGate() {
  const viewer = useViewer();
  const location = useLocation();
  const permission = MENU_PERMISSIONS[`/${location.pathname.split('/')[1] || ''}`];
  return permission && !can(viewer, permission) ? (
    <Result status="403" title="暂无管理权限" subTitle="当前账号没有该模块的访问权限。" />
  ) : (
    <Outlet />
  );
}
function LoginRoute() {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <Loading />;
  if (session.data?.login && session.data.is_admin && !session.error) {
    const from = location.state?.from;
    return (
      <Navigate
        to={
          typeof from === 'string' &&
          from.startsWith('/') &&
          !from.startsWith('//') &&
          !from.startsWith('/login')
            ? from
            : '/'
        }
        replace
      />
    );
  }
  return <Login />;
}
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Result
        status="error"
        title="页面加载失败"
        subTitle="请刷新页面后重试。"
        extra={<Button onClick={() => window.location.reload()}>刷新页面</Button>}
      />
    ) : (
      this.props.children
    );
  }
}
export default function Application() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route element={<PermissionGate />}>
            <Route path="draft/:id" element={<Draft />} />
            <Route path="admin/pick/:id" element={<Draft />} />
            <Route path="admin/auction/:id" element={<RetiredAuction />} />
            <Route path="auction/:id" element={<RetiredAuction />} />
            <Route element={<Shell />}>
              <Route element={<ModuleGate />}>
                <Route index element={<Dashboard />} />
                <Route path="users" element={<Users />} />
                <Route path="matches" element={<Matches />} />
                <Route path="matches/:id" element={<MatchManage />} />
                <Route path="matches/:id/lineup" element={<DraftLineup />} />
                <Route path="signups" element={<Signups />} />
                <Route path="seasons" element={<Seasons />} />
                <Route path="seasons/:id" element={<SeasonManage />} />
                <Route path="videos" element={<Videos />} />
                <Route path="community" element={<Community />} />
                <Route element={<PermissionGate core />}>
                  <Route path="shop" element={<Shop />} />
                  <Route path="markets" element={<Markets />} />
                  <Route path="recharge" element={<Recharge />} />
                  <Route path="sponsors" element={<Sponsors />} />
                </Route>
                <Route
                  path="*"
                  element={
                    <Result
                      status="404"
                      title="页面不存在"
                      extra={<Button href="/">返回工作台</Button>}
                    />
                  }
                />
              </Route>
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
