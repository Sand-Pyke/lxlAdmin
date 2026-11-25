import { useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { post, request } from '../api/client';
import type { Signup } from '../api/types';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import { POSITION_OPTIONS, positionText } from '../data/draft-options';
import { empty, label, QueryError, Refresh, tableScrollY } from '../components/shared';

export default function Signups() {
  const viewer = useViewer();
  const [search, setSearch] = useSearchParams();
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [positionRow, setPositionRow] = useState<Signup | null>(null);
  const [positionForm] = Form.useForm<{ main_pos: string; role?: 'STARTER' | 'SUB' }>();
  const client = useQueryClient();
  const { message } = App.useApp();
  const event = search.get('event') || '';
  const query = useQuery({
    queryKey: ['signups'],
    queryFn: ({ signal }) => request<{ signup_list: Signup[] }>('/api/admin/sign/list', { signal }),
  });
  const events = [
    ...new Map(
      (query.data?.signup_list || []).map((row) => [
        `${row.source}:${row.event_id}`,
        {
          value: `${row.source}:${row.event_id}`,
          label: `${row.event_name}（${row.source === 'season' ? '战队赛' : '常规赛'}）`,
        },
      ]),
    ).values(),
  ];
  const rows = (query.data?.signup_list || []).filter(
    (row) =>
      (!event || `${row.source}:${row.event_id}` === event) &&
      `${row.username} ${row.game_name}`.toLowerCase().includes(keyword.toLowerCase()),
  );
  const cancel = useMutation({
    mutationFn: (row: Signup) =>
      post(`/api/admin/sign/cancel/${row.sign_id}${row.source === 'season' ? '?type=season' : ''}`),
    onSuccess: async (data) => {
      void message.success(data.msg || '报名已取消');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['signups'] }),
        client.invalidateQueries({ queryKey: ['matches'] }),
      ]);
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  const changePosition = useMutation({
    mutationFn: (values: { main_pos: string; role?: 'STARTER' | 'SUB' }) => {
      if (!positionRow) throw new Error('请先选择报名记录');
      const season = positionRow.source === 'season';
      return post(
        `/api/admin/sign/position/${positionRow.sign_id}${season ? '?type=season' : ''}`,
        season ? values : { main_pos: values.main_pos },
      );
    },
    onSuccess: async () => {
      setPositionRow(null);
      void message.success('报名位置已更新');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['signups'] }),
        client.invalidateQueries({ queryKey: ['matches'] }),
        client.invalidateQueries({ queryKey: ['season-board'] }),
      ]);
    },
    onError: (error) => void message.error(error.message),
  });
  return (
    <>
      <div className="table-page">
        <QueryError error={query.error} retry={query.refetch} />
        <Card className="content-card table-card">
          <div className="table-toolbar">
            <Space wrap>
              <Input.Search
                aria-label="搜索报名选手"
                allowClear
                placeholder="搜索选手账号或游戏 ID"
                onSearch={(value) => {
                  setKeyword(value);
                  setPage(1);
                }}
                style={{ width: 280 }}
              />
              <Select
                aria-label="筛选报名赛事"
                value={event}
                showSearch
                optionFilterProp="label"
                style={{ width: 280 }}
                onChange={(value) => {
                  setSearch(value ? { event: value } : {});
                  setPage(1);
                }}
                options={[{ value: '', label: '全部赛事' }, ...events]}
              />
            </Space>
            <Refresh run={query.refetch} loading={query.isFetching} />
          </div>
          <Table<Signup>
            rowKey={(row) => `${row.source}:${row.sign_id}`}
            dataSource={rows}
            loading={query.isPending}
            locale={{ emptyText: empty }}
            scroll={{ x: 900, y: tableScrollY }}
            pagination={{
              current: page,
              onChange: setPage,
              showTotal: (total) => `共 ${total} 条报名`,
            }}
            columns={[
              {
                title: '选手',
                render: (_, row) => (
                  <div className="cell-title">
                    {row.game_name || row.username}
                    <small>{row.username}</small>
                  </div>
                ),
              },
              { title: '赛事', dataIndex: 'event_name' },
              {
                title: '类型',
                dataIndex: 'source',
                render: (value) => (value === 'season' ? '战队赛' : '常规赛'),
              },
              { title: '段位', dataIndex: 'rank', render: (value) => value || '未设置' },
              { title: '分路', dataIndex: 'main_pos', render: label },
              {
                title: '报名身份',
                render: (_, row) => (
                  <Space>
                    <Tag bordered={false} color={row.is_waitlisted ? 'gold' : 'green'}>
                      {row.is_waitlisted ? '候补' : '正式'}
                    </Tag>
                    {row.is_captain && <Tag bordered={false}>队长</Tag>}
                  </Space>
                ),
              },
              {
                title: '操作',
                render: (_, row) => (
                  <Space wrap size={4}>
                    {can(viewer, 'signups.position') &&
                      (row.source === 'match' || viewer.is_core_admin) && (
                        <Button
                          type="link"
                          onClick={() => {
                            positionForm.setFieldsValue({
                              main_pos: POSITION_OPTIONS.includes(row.main_pos)
                                ? row.main_pos
                                : 'TOP',
                              role: row.team_role === 'SUB' ? 'SUB' : 'STARTER',
                            });
                            setPositionRow(row);
                          }}
                        >
                          更换位置
                        </Button>
                      )}
                    {can(
                      viewer,
                      row.source === 'season' ? 'signups.season.cancel' : 'signups.cancel',
                    ) ? (
                      <Popconfirm
                        title={`取消 ${row.username} 的报名？`}
                        description="取消后可能触发候补递补，请核对赛事和选手。"
                        onConfirm={() => cancel.mutateAsync(row).catch(() => undefined)}
                      >
                        <Button type="link" danger disabled={cancel.isPending}>
                          取消报名
                        </Button>
                      </Popconfirm>
                    ) : null}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </div>
      <Modal
        title={positionRow ? `更换 ${positionRow.username} 的报名位置` : '更换报名位置'}
        open={Boolean(positionRow)}
        onCancel={() => setPositionRow(null)}
        onOk={() => positionForm.submit()}
        confirmLoading={changePosition.isPending}
        closable={!changePosition.isPending}
        mask={{ closable: !changePosition.isPending }}
        cancelButtonProps={{ disabled: changePosition.isPending }}
      >
        <Form
          form={positionForm}
          layout="vertical"
          onFinish={(values) => changePosition.mutate(values)}
        >
          <Form.Item label="报名分路" name="main_pos" rules={[{ required: true }]}>
            <Select
              options={POSITION_OPTIONS.map((value) => ({ value, label: positionText(value) }))}
            />
          </Form.Item>
          {positionRow?.source === 'season' && (
            <Form.Item label="报名身份" name="role" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'STARTER', label: '首发' },
                  { value: 'SUB', label: '替补' },
                ]}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  );
}
