import { useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Table } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { post, request } from '../api/client';
import type { Season } from '../api/types';
import { dateText, empty, QueryError, Refresh, Status, tableScrollY } from '../components/shared';
import { can } from '../permissions/access';
import { useViewer } from '../auth';

export default function Seasons() {
  const viewer = useViewer();
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<{ name: string; startDate?: string }>();
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: ['seasons'],
    queryFn: ({ signal }) => request<{ seasons: Season[] }>('/api/admin/season/list', { signal }),
  });
  const create = useMutation({
    mutationFn: (values: { name: string; startDate?: string }) =>
      post('/api/admin/season/create', values),
    onSuccess: async () => {
      setCreating(false);
      void message.success('战队赛已创建');
      await query.refetch();
    },
    onError: (error) => void message.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (seasonId: number) => post('/api/admin/season/delete', { seasonId }),
    onSuccess: async () => {
      void message.success('战队赛已删除');
      await query.refetch();
    },
    onError: (error) => void message.error(error.message),
  });
  return (
    <>
      <div className="table-page">
        <QueryError error={query.error} retry={query.refetch} />
        <Card className="content-card table-card">
          <div className="table-toolbar">
            <Input.Search
              allowClear
              aria-label="搜索战队赛"
              placeholder="搜索战队赛名称"
              style={{ width: 280 }}
              onSearch={(value) => {
                setKeyword(value);
                setPage(1);
              }}
            />
            <Refresh run={query.refetch} loading={query.isFetching} />
            {viewer.is_core_admin && (
              <Button
                type="primary"
                onClick={() => {
                  form.resetFields();
                  setCreating(true);
                }}
              >
                创建战队赛
              </Button>
            )}
          </div>
          <Table<Season>
            rowKey="id"
            dataSource={query.data?.seasons.filter((row) =>
              row.name.toLowerCase().includes(keyword.toLowerCase()),
            )}
            loading={query.isPending}
            locale={{ emptyText: empty }}
            scroll={{ x: 800, y: tableScrollY }}
            pagination={{ current: page, onChange: setPage }}
            columns={[
              {
                title: '赛事名称',
                dataIndex: 'name',
                render: (_, row) => (
                  <div className="cell-title">
                    {can(viewer, 'seasons.view') ? (
                      <Link to={`/seasons/${row.id}`}>{row.name}</Link>
                    ) : (
                      row.name
                    )}
                    <small>#{row.id}</small>
                  </div>
                ),
              },
              { title: '阶段', dataIndex: 'status', render: (value) => <Status value={value} /> },
              { title: '战队数', dataIndex: 'team_count' },
              { title: '对局数', dataIndex: 'match_count' },
              { title: '报名人数', dataIndex: 'signup_count' },
              { title: '开始时间', dataIndex: 'start_date', render: dateText },
              ...(viewer.is_core_admin
                ? [
                    {
                      title: '操作',
                      render: (_value: unknown, row: Season) => (
                        <Popconfirm
                          title={`删除「${row.name}」？`}
                          description="此操作会删除该战队赛及关联记录。"
                          onConfirm={() => remove.mutateAsync(row.id).catch(() => undefined)}
                        >
                          <Button type="link" danger disabled={remove.isPending}>
                            删除
                          </Button>
                        </Popconfirm>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      </div>
      <Modal
        title="创建战队赛"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        cancelButtonProps={{ disabled: create.isPending }}
        closable={!create.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)}>
          <Form.Item label="战队赛名称" name="name" rules={[{ required: true, whitespace: true }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item
            label="赛程起始日（第一周周六）"
            name="startDate"
            rules={[
              {
                validator: async (_, value?: string) => {
                  if (value && new Date(`${value}T00:00:00Z`).getUTCDay() !== 6)
                    throw new Error('请选择周六');
                },
              },
            ]}
          >
            <Input type="date" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
