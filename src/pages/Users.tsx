import { useState } from 'react';
import {
  App,
  Avatar,
  Button,
  Card,
  Dropdown,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { params, post, request } from '../api/client';
import type { User, UsersResponse } from '../api/types';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import UserActionDialog from '../components/UserActionDialog';
import { USER_ACTIONS } from '../api/user-actions';
import type { UserAction } from '../api/user-actions';
import {
  dateText,
  empty,
  label,
  QueryError,
  Refresh,
  Status,
  tableScrollY,
} from '../components/shared';

export default function Users() {
  const [search, setSearch] = useSearchParams();
  const viewer = useViewer();
  const client = useQueryClient();
  const { message } = App.useApp();
  const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(search.get('status') || '')
    ? search.get('status')!
    : '';
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [action, setAction] = useState<{ type: UserAction; target: User } | null>(null);
  const [role, setRole] = useState('');
  const query = useQuery({
    queryKey: ['users', { status, keyword, page, pageSize, role }],
    queryFn: ({ signal }) =>
      request<UsersResponse>(
        `/api/admin/users?${params({ status, keyword, page: page - 1, pageSize, role })}`,
        { signal },
      ),
  });
  const mutation = useMutation({
    mutationFn: ({ userId, status }: { userId: number; status: string }) =>
      post('/api/admin/users/status', { userId, status }),
    onSuccess: async (data) => {
      setSelected([]);
      void message.success(data.msg || '审核已提交');
      await client.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  const batch = useMutation({
    mutationFn: () => post('/api/admin/users/batch-approve', { userIds: selected }),
    onSuccess: async (data) => {
      setSelected([]);
      void message.success(data.msg || '批量审核完成');
      await client.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  const canReview = (row: User) => can(viewer, 'users.review', row);
  const busy = mutation.isPending || batch.isPending;
  return (
    <>
      <div className="table-page">
        <QueryError error={query.error} retry={query.refetch} />
        <Card className="content-card table-card">
          <div className="table-toolbar">
            <Space wrap>
              <Select
                aria-label="用户角色筛选"
                value={role}
                virtual={false}
                style={{ width: 160 }}
                onChange={(value) => {
                  setRole(value);
                  setPage(1);
                  setSelected([]);
                }}
                options={[
                  { value: '', label: '全部角色' },
                  { value: 'USER', label: '普通用户' },
                  { value: 'ADMIN', label: '普通管理员' },
                  { value: 'SECONDARY_ADMIN', label: '二级管理员' },
                  { value: 'CORE_ADMIN', label: '核心管理员' },
                ]}
              />
              <Input.Search
                aria-label="搜索用户"
                placeholder="搜索账号、游戏 ID、KOOK"
                allowClear
                onSearch={(value) => {
                  setKeyword(value);
                  setPage(1);
                  setSelected([]);
                }}
                style={{ width: 290 }}
              />
              <Select
                aria-label="审核状态"
                value={status}
                style={{ width: 150 }}
                onChange={(value) => {
                  setSearch(value ? { status: value } : {});
                  setPage(1);
                  setSelected([]);
                }}
                options={[
                  { value: '', label: '全部审核状态' },
                  ...['PENDING', 'APPROVED', 'REJECTED'].map((value) => ({
                    value,
                    label: label(value),
                  })),
                ]}
              />
            </Space>
            <Space wrap>
              {selected.length > 0 && can(viewer, 'users.review') && (
                <Popconfirm
                  title={`通过选中的 ${selected.length} 个账号？`}
                  onConfirm={() => batch.mutateAsync().catch(() => undefined)}
                >
                  <Button type="primary" loading={batch.isPending} disabled={mutation.isPending}>
                    批量通过（{selected.length}）
                  </Button>
                </Popconfirm>
              )}
              <Refresh run={query.refetch} loading={query.isFetching} />
            </Space>
          </div>
          <Table<User>
            className="users-table"
            tableLayout="fixed"
            rowKey="id"
            dataSource={query.data?.users}
            loading={query.isPending}
            scroll={{ x: 1400, y: tableScrollY }}
            locale={{ emptyText: empty }}
            rowSelection={{
              columnWidth: 48,
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys),
              getCheckboxProps: (row) => ({
                disabled: busy || !canReview(row) || row.isAdmin || row.status !== 'PENDING',
              }),
            }}
            pagination={{
              current: page,
              pageSize,
              total: query.data?.total || 0,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 位可管理用户`,
              onChange: (next, size) => {
                setPage(next);
                setPageSize(size);
                setSelected([]);
              },
            }}
            columns={[
              {
                title: '用户',
                dataIndex: 'username',
                width: 210,
                render: (_, row) => (
                  <Space>
                    <Avatar src={row.profile?.avatar || undefined} icon={<UserOutlined />} />
                    <div className="cell-title">
                      {row.username}
                      <small>UID {row.id}</small>
                    </div>
                  </Space>
                ),
              },
              {
                title: '游戏 ID',
                width: 230,
                render: (_, row) => (
                  <div className="cell-title">
                    {row.profile?.gameName || '未填写'}
                    <small>{row.kookName || '未绑定 KOOK'}</small>
                  </div>
                ),
              },
              {
                title: '段位',
                width: 150,
                render: (_, row) => (
                  <div className="user-rank-cell">
                    {row.profile?.rank || '未设置'}
                    <small className="cell-sub">{label(row.profile?.mainPosition)}</small>
                    {row.pendingRank && <Tag color="gold">申请：{row.pendingRank}</Tag>}
                  </div>
                ),
              },
              {
                title: '角色',
                width: 140,
                render: (_, row) => (
                  <Tag bordered={false}>
                    {row.isCoreAdmin
                      ? '核心管理员'
                      : row.isSecondaryAdmin
                        ? '二级管理员'
                        : row.isAdmin
                          ? '管理员'
                          : '用户'}
                  </Tag>
                ),
              },
              {
                title: '审核状态',
                dataIndex: 'status',
                width: 120,
                render: (value) => <Status value={value} />,
              },
              { title: '注册时间', dataIndex: 'createdAt', render: dateText, width: 175 },
              {
                title: '报名处罚',
                width: 180,
                render: (_, row) =>
                  row.banUntil && new Date(row.banUntil).getTime() > Date.now() ? (
                    <div>
                      <Tag color="red">处罚中</Tag>
                      <small className="cell-sub">至 {dateText(row.banUntil)}</small>
                    </div>
                  ) : (
                    <Tag bordered={false}>正常</Tag>
                  ),
              },
              {
                title: '操作',
                width: 110,
                render: (_, row) => {
                  const actions = (Object.keys(USER_ACTIONS) as UserAction[])
                    .filter((type) => can(viewer, USER_ACTIONS[type].permission, row))
                    .filter(
                      (type) =>
                        type !== 'unban' ||
                        Boolean(row.banUntil && new Date(row.banUntil).getTime() > Date.now()),
                    )
                    .map((type) => {
                      const reason =
                        type === 'role' && row.status !== 'APPROVED'
                          ? '请先通过账号审核再设置角色'
                          : type === 'delete' && row.status === 'PENDING'
                            ? '待审核账号请先完成审核或拒绝申请'
                            : '';
                      return {
                        key: type,
                        label: reason
                          ? `${USER_ACTIONS[type].label}（需先审核）`
                          : USER_ACTIONS[type].label,
                        danger: type === 'delete' || type === 'ban',
                        disabled: busy || Boolean(reason),
                      };
                    });
                  return actions.length ? (
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: actions,
                        onClick: ({ key }) => setAction({ type: key as UserAction, target: row }),
                      }}
                    >
                      <Button type="link" size="small" disabled={busy}>
                        操作
                      </Button>
                    </Dropdown>
                  ) : (
                    <span className="muted">—</span>
                  );
                },
              },
              {
                title: '审核操作',
                width: 160,
                fixed: 'right',
                render: (_, row) =>
                  canReview(row) && (row.status === 'PENDING' || row.pendingRank) ? (
                    <Space>
                      <Popconfirm
                        title={`通过 ${row.username} 的申请？`}
                        description={
                          row.pendingRank
                            ? `段位将更新为 ${row.pendingRank}`
                            : '通过后该用户可以登录平台。'
                        }
                        onConfirm={() =>
                          mutation
                            .mutateAsync({ userId: row.id, status: 'APPROVED' })
                            .catch(() => undefined)
                        }
                      >
                        <Button size="small" type="link" disabled={busy}>
                          通过
                        </Button>
                      </Popconfirm>
                      {!row.isAdmin && (
                        <Popconfirm
                          title={`拒绝 ${row.username} 的申请？`}
                          onConfirm={() =>
                            mutation
                              .mutateAsync({ userId: row.id, status: 'REJECTED' })
                              .catch(() => undefined)
                          }
                        >
                          <Button danger size="small" type="link" disabled={busy}>
                            拒绝
                          </Button>
                        </Popconfirm>
                      )}
                    </Space>
                  ) : (
                    <span className="muted">—</span>
                  ),
              },
            ]}
          />
        </Card>
      </div>
      {action && (
        <UserActionDialog
          key={`${action.type}:${action.target.id}`}
          action={action.type}
          target={action.target}
          onClose={() => setAction(null)}
        />
      )}
    </>
  );
}
