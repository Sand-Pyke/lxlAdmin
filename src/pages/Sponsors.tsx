import { useEffect, useState } from 'react';
import {
  App,
  Avatar,
  Button,
  Card,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, UserOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { params, post, request } from '../api/client';
import type { SponsorEntry, UsersResponse } from '../api/types';
import { empty, QueryError, Refresh, tableScrollY } from '../components/shared';

type PlayerOption = {
  id: number;
  name: string;
  gameName: string;
};

const amountText = (amount: number) =>
  `¥${amount.toLocaleString('zh-CN', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

function playerLabel(player: PlayerOption) {
  const gameName = player.gameName?.trim();
  return gameName ? `${gameName}（${player.name}）` : player.name;
}

const medalColors = ['gold', 'default', 'volcano'];

export default function Sponsors() {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [addOpen, setAddOpen] = useState(false);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | undefined>();
  const [amount, setAmount] = useState(1);
  const [playerSearch, setPlayerSearch] = useState('');
  const [playerKeyword, setPlayerKeyword] = useState('');
  const [editTarget, setEditTarget] = useState<SponsorEntry | null>(null);
  const [editAmount, setEditAmount] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => setPlayerKeyword(playerSearch.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [playerSearch]);

  const query = useQuery({
    queryKey: ['sponsors'],
    queryFn: ({ signal }) => request<{ sponsors: SponsorEntry[] }>('/api/sponsors', { signal }),
  });
  const players = useQuery({
    queryKey: ['sponsor-players', playerKeyword],
    enabled: Boolean(playerKeyword),
    queryFn: ({ signal }) =>
      request<UsersResponse>(
        `/api/admin/users?${params({ keyword: playerKeyword, page: 0, pageSize: 20 })}`,
        { signal },
      ),
  });

  const add = useMutation({
    mutationFn: () => post('/api/admin/sponsors', { userId: selectedPlayerId, amount }),
    onSuccess: async (data) => {
      void message.success(data.msg || '已添加赞助人');
      setAddOpen(false);
      setSelectedPlayerId(undefined);
      setAmount(1);
      setPlayerSearch('');
      setPlayerKeyword('');
      await client.invalidateQueries({ queryKey: ['sponsors'] });
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  const update = useMutation({
    mutationFn: (target: SponsorEntry) =>
      post(`/api/admin/sponsors/${target.id}`, { amount: editAmount }),
    onSuccess: async (data) => {
      void message.success(data.msg || '已更新赞助金额');
      setEditTarget(null);
      await client.invalidateQueries({ queryKey: ['sponsors'] });
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  const remove = useMutation({
    mutationFn: (row: SponsorEntry) =>
      request<{ msg?: string }>(`/api/admin/sponsors/${row.id}`, { method: 'DELETE' }),
    onSuccess: async (data) => {
      void message.success(data.msg || '已移出赞助名单');
      await client.invalidateQueries({ queryKey: ['sponsors'] });
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });

  const sponsors = query.data?.sponsors || [];
  const totalAmount = sponsors.reduce((sum, sponsor) => sum + sponsor.amount, 0);
  const existingIds = new Set(sponsors.map((sponsor) => sponsor.userId));
  const availableOptions = (players.data?.users || [])
    .filter((user) => Boolean(user.profile) && !existingIds.has(user.id))
    .map((user) => ({
      value: user.id,
      label: playerLabel({
        id: user.id,
        name: user.username,
        gameName: user.profile?.gameName ?? '',
      }),
    }));

  const closeAdd = () => {
    if (add.isPending) return;
    setAddOpen(false);
    setSelectedPlayerId(undefined);
    setAmount(1);
    setPlayerSearch('');
    setPlayerKeyword('');
  };
  const submitAdd = () => {
    if (selectedPlayerId == null) {
      void message.warning('请选择赞助选手');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      void message.warning('请填写赞助金额');
      return;
    }
    add.mutate();
  };
  const submitEdit = () => {
    if (!editTarget) return;
    if (!Number.isFinite(editAmount) || editAmount <= 0) {
      void message.warning('请填写赞助金额');
      return;
    }
    update.mutate(editTarget);
  };
  const busy = add.isPending || update.isPending || remove.isPending;

  return (
    <>
      <div className="table-page">
        <QueryError error={query.error} retry={query.refetch} />
        <Card className="content-card table-card">
          <div className="table-toolbar">
            <span className="muted">
              赞助人数 {sponsors.length} · 累计赞助 {amountText(totalAmount)}
            </span>
            <Space wrap>
              <Refresh run={query.refetch} loading={query.isFetching} />
              <Button
                type="primary"
                aria-label="添加赞助人"
                icon={<PlusOutlined />}
                onClick={() => setAddOpen(true)}
              >
                添加赞助人
              </Button>
            </Space>
          </div>
          <Table<SponsorEntry>
            rowKey="id"
            dataSource={sponsors}
            loading={query.isPending}
            locale={{ emptyText: empty }}
            scroll={{ x: 780, y: tableScrollY }}
            pagination={false}
            columns={[
              {
                title: '排名',
                width: 80,
                align: 'center',
                render: (_, __, index) => {
                  const place = index + 1;
                  return place <= 3 ? (
                    <Tag color={medalColors[index]} bordered={false}>
                      {place}
                    </Tag>
                  ) : (
                    place
                  );
                },
              },
              {
                title: '赞助人',
                width: 240,
                render: (_, row) => (
                  <Space>
                    <Avatar src={row.avatar || undefined} icon={<UserOutlined />} />
                    <div className="cell-title">
                      {row.gameName || row.name}
                      <small>{row.gameName ? row.name : '选手'}</small>
                    </div>
                  </Space>
                ),
              },
              {
                title: '赞助金额',
                width: 140,
                render: (_, row) => <strong>{amountText(row.amount)}</strong>,
              },
              {
                title: '操作',
                width: 180,
                render: (_, row) => (
                  <Space wrap>
                    <Button
                      type="link"
                      icon={<EditOutlined />}
                      disabled={busy}
                      onClick={() => {
                        setEditTarget(row);
                        setEditAmount(row.amount);
                      }}
                    >
                      修改金额
                    </Button>
                    <Popconfirm
                      title="移出赞助名单"
                      description={`确认将 ${row.gameName || row.name} 移出赞助名单？`}
                      okText="移除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => remove.mutate(row)}
                    >
                      <Button type="link" danger icon={<DeleteOutlined />} disabled={busy}>
                        移除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </div>
      <Modal
        title="添加赞助人"
        open={addOpen}
        okText="添加"
        cancelText="取消"
        confirmLoading={add.isPending}
        onOk={submitAdd}
        onCancel={closeAdd}
        cancelButtonProps={{ disabled: add.isPending }}
        maskClosable={!add.isPending}
        closable={!add.isPending}
      >
        <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 24 }}>
          <Select
            showSearch
            filterOption={false}
            value={selectedPlayerId}
            placeholder="搜索选手（游戏 ID / 用户名）"
            loading={players.isFetching}
            notFoundContent={
              playerKeyword
                ? players.isFetching
                  ? '搜索中…'
                  : '未找到匹配选手'
                : '输入关键字搜索选手'
            }
            onSearch={(value) => setPlayerSearch(value)}
            onChange={(value) => setSelectedPlayerId(value)}
            options={availableOptions}
          />
          <InputNumber
            min={0.01}
            precision={2}
            value={amount}
            addonAfter="元"
            style={{ width: '100%' }}
            onChange={(value) => setAmount(Number(value ?? 1))}
          />
        </Space>
      </Modal>
      <Modal
        title={`修改赞助金额 · ${editTarget ? editTarget.gameName || editTarget.name : ''}`}
        open={editTarget !== null}
        okText="保存"
        cancelText="取消"
        confirmLoading={update.isPending}
        onOk={submitEdit}
        onCancel={() => {
          if (!update.isPending) setEditTarget(null);
        }}
        cancelButtonProps={{ disabled: update.isPending }}
        maskClosable={!update.isPending}
        closable={!update.isPending}
      >
        <InputNumber
          min={0.01}
          precision={2}
          value={editAmount}
          addonAfter="元"
          style={{ width: '100%', marginTop: 24 }}
          onChange={(value) => setEditAmount(Number(value ?? 1))}
        />
      </Modal>
    </>
  );
}
