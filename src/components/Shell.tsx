import { useState } from 'react';
import { App, Avatar, Breadcrumb, Button, Drawer, Dropdown, Menu } from 'antd';
import {
  AppstoreOutlined,
  BarChartOutlined,
  WalletOutlined,
  DashboardOutlined,
  GoldOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuOutlined,
  ScheduleOutlined,
  ShoppingOutlined,
  TeamOutlined,
  TrophyOutlined,
  UserOutlined,
  VideoCameraOutlined,
  CommentOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { roleLabel, useViewer } from '../auth';
import { post } from '../api/client';
import { can, MENU_PERMISSIONS } from '../permissions/access';
import ChangePassword from './ChangePassword';

const items = [
  { key: '/', icon: <DashboardOutlined />, label: '工作台' },
  { key: '/users', icon: <UserOutlined />, label: '用户管理' },
  { key: '/signups', icon: <TeamOutlined />, label: '报名管理' },
  { key: '/matches', icon: <TrophyOutlined />, label: '常规赛事' },
  { key: '/seasons', icon: <ScheduleOutlined />, label: '战队赛事' },
  { key: '/markets', icon: <BarChartOutlined />, label: '竞猜管理' },
  { key: '/shop', icon: <ShoppingOutlined />, label: '商品管理' },
  { key: '/recharge', icon: <WalletOutlined />, label: '冠军币充值' },
  { key: '/sponsors', icon: <GoldOutlined />, label: '赞助管理' },
  { key: '/videos', icon: <VideoCameraOutlined />, label: '视频管理' },
  { key: '/community', icon: <CommentOutlined />, label: '社区管理' },
];
export default function Shell() {
  const viewer = useViewer();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const logout = useMutation({
    mutationFn: () => post('/api/logout'),
    onSuccess: async () => {
      await client.cancelQueries();
      client.clear();
      navigate('/login', { replace: true });
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  const visible = items.filter((item) => can(viewer, MENU_PERMISSIONS[item.key]));
  const key =
    visible.find((item) => item.key !== '/' && location.pathname.startsWith(item.key))?.key || '/';
  const nav = (
    <>
      <Link className="brand" to="/">
        <span className="brand-symbol">L</span>
        <span>
          LXL <small>联赛管理平台</small>
        </span>
      </Link>
      <div className="nav-caption">赛事运营</div>
      <Menu
        mode="inline"
        selectedKeys={[key]}
        items={visible}
        onClick={({ key }) => {
          navigate(key);
          setOpen(false);
        }}
      />
      <div className="sidebar-bottom">
        <AppstoreOutlined />
        <div>
          峡谷冠军联赛<small>独立管理工作空间</small>
        </div>
      </div>
    </>
  );
  return (
    <div className="admin-app">
      <aside className="sidebar">{nav}</aside>
      <Drawer
        placement="left"
        width={246}
        open={open}
        onClose={() => setOpen(false)}
        styles={{ body: { padding: 0, background: '#172b28' } }}
        className="mobile-drawer"
      >
        {nav}
      </Drawer>
      <div className="main-wrap">
        <header className="topbar">
          <div className="header-left">
            <Button
              className="mobile-menu"
              type="text"
              icon={<MenuOutlined />}
              aria-label="展开导航"
              onClick={() => setOpen(true)}
            />
            <Breadcrumb
              items={[
                { title: '管理平台' },
                { title: visible.find((item) => item.key === key)?.label },
              ]}
            />
          </div>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'pwd', label: '修改密码', icon: <KeyOutlined /> },
                {
                  key: 'logout',
                  label: logout.isPending ? '正在退出…' : '退出登录',
                  icon: <LogoutOutlined />,
                  disabled: logout.isPending,
                },
              ],
              onClick: ({ key }) => {
                if (key === 'logout') logout.mutate();
                if (key === 'pwd') setPwdOpen(true);
              },
            }}
          >
            <button className="account-button">
              <Avatar style={{ background: '#e8eee6', color: '#365e45' }} icon={<UserOutlined />} />
              <span>
                {viewer.username}
                <small>{roleLabel(viewer)}</small>
              </span>
            </button>
          </Dropdown>
        </header>
        <main className="page-content">
          <Outlet />
        </main>
      </div>
      <ChangePassword open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </div>
  );
}
