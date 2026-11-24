import { useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Select, Space, Switch, Table } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { params, post, request } from '../api/client';
import type { Match, MatchesResponse } from '../api/types';
import Permit from '../components/Permit';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import {
  dateText,
  empty,
  label,
  PageTitle,
  QueryError,
  Refresh,
  Status,
} from '../components/shared';

type MatchForm = {
  name: string;
  bo: string;
  round: string;
  date?: string;
  use_fee: boolean;
  captain_position?: string;
};
export default function Matches() {
  const viewer = useViewer();
  const [search, setSearch] = useSearchParams();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const client = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<MatchForm>();
  const open = search.get('create') === '1' && can(viewer, 'matches.create');
  const query = useQuery({
    queryKey: ['matches', { page, pageSize, status, keyword }],
    queryFn: ({ signal }) =>
      request<MatchesResponse>(
        `/api/match/list?${params({ page: page - 1, pageSize, status, keyword, sort: 'created_desc' })}`,
        { signal },
      ),
  });
  const create = useMutation({
    mutationFn: (values: MatchForm) =>
      post('/api/admin/match/create', {
        ...values,
        date: values.date ? `${values.date}:00+08:00` : null,
      }),
    onSuccess: async (data) => {
      void message.success(data.msg || '赛事已创建');
      setSearch({});
      form.resetFields();
      setPage(1);
      await client.invalidateQueries({ queryKey: ['matches'] });
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  return (
    <>
      <PageTitle
        title="常规赛事"
        description="管理比赛信息、报名状态与赛事排期。"
        extra={
          <>
            <Refresh run={query.refetch} loading={query.isFetching} />
            <Permit permission="matches.create">
              <Button
                type="primary"
                aria-label="创建常规赛"
                icon={<PlusOutlined />}
                onClick={() => setSearch({ create: '1' })}
              >
                创建常规赛
              </Button>
            </Permit>
          </>
        }
      />
      <QueryError error={query.error} retry={query.refetch} />
      <Card className="content-card">
        <div className="table-toolbar">
          <Space wrap>
            <Input.Search
              aria-label="搜索赛事"
              placeholder="搜索赛事名称"
              allowClear
              onSearch={(value) => {
                setKeyword(value);
                setPage(1);
              }}
              style={{ width: 280 }}
            />
            <Select
              aria-label="赛事状态"
              value={status}
              style={{ width: 150 }}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={[
                { value: '', label: '全部赛事状态' },
                ...['CREATED', 'LIVE', 'FINISHED'].map((value) => ({ value, label: label(value) })),
              ]}
            />
          </Space>
        </div>
        <Table<Match>
          rowKey="id"
          dataSource={query.data?.match_list}
          loading={query.isPending}
          locale={{ emptyText: empty }}
          scroll={{ x: 950 }}
          pagination={{
            current: page,
            pageSize,
            total: query.data?.total || 0,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 场赛事`,
            onChange: (value, size) => {
              setPage(value);
              setPageSize(size);
            },
          }}
          columns={[
            {
              title: '赛事',
              dataIndex: 'name',
              render: (_, row) => (
                <div className="cell-title">
                  {row.name}
                  <small>
                    #{row.id} · {row.round}
                  </small>
                </div>
              ),
            },
            { title: '状态', dataIndex: 'status', render: (value) => <Status value={value} /> },
            { title: '赛制', dataIndex: 'bo' },
            {
              title: '选手 / 队伍',
              render: (_, row) => `${row.player_count} 人 / ${row.team_count} 队`,
            },
            { title: '排期时间', dataIndex: 'date', render: dateText },
            { title: '创建人', dataIndex: 'createdByName', render: (value) => value || '—' },
            {
              title: '选人 / 对阵',
              width: 170,
              render: (_, row) => (
                <Space orientation="vertical">
                  {row.status === 'CREATED' &&
                    can(viewer, 'draft.view') &&
                    can(viewer, 'draft.control') && <Link to={`/draft/${row.id}`}>大屏选人</Link>}
                  {can(viewer, 'draft.view') && (
                    <Link to={`/matches/${row.id}/lineup`}>查看对阵</Link>
                  )}
                </Space>
              ),
            },
            {
              title: '报名',
              render: (_, row) =>
                row.status === 'CREATED' ? (
                  <Link to={`/signups?event=match:${row.id}`}>查看报名</Link>
                ) : (
                  <span className="muted">已截止</span>
                ),
            },
          ]}
        />
      </Card>
      <Modal
        title="创建常规赛"
        open={open}
        onCancel={() => {
          if (!create.isPending) setSearch({});
        }}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        okText="创建赛事"
        cancelText="取消"
        cancelButtonProps={{ disabled: create.isPending }}
        maskClosable={!create.isPending}
        closable={!create.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ bo: 'BO1', round: '常规赛', use_fee: true, captain_position: '' }}
          onFinish={(values) => create.mutate(values)}
          style={{ marginTop: 24 }}
        >
          <Form.Item
            name="name"
            label="赛事名称"
            rules={[
              { required: true, whitespace: true, message: '请输入赛事名称' },
              { max: 100, message: '最多 100 个字' },
            ]}
          >
            <Input placeholder="例如：LXL 周末常规赛" maxLength={100} />
          </Form.Item>
          <Form.Item name="bo" label="赛制" rules={[{ required: true }]}>
            <Select
              options={[
                'BO1',
                'BO3',
                'BO5',
                '六队模式',
                '六队模式2.0',
                '八队模式',
                '八队模式2.0',
              ].map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item name="round" label="赛事轮次" rules={[{ required: true, whitespace: true }]}>
            <Input maxLength={40} />
          </Form.Item>
          <Form.Item name="date" label="排期时间（北京时间）">
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="captain_position" label="队长分路">
            <Select
              options={[
                { value: '', label: '不限定分路' },
                ...['TOP', 'JUG', 'MID', 'ADC', 'SUP'].map((value) => ({
                  value,
                  label: label(value),
                })),
              ]}
            />
          </Form.Item>
          <Form.Item name="use_fee" label="启用费用机制" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
