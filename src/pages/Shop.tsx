import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { post, request } from '../api/client';
import type { ShopItem } from '../api/types';
import { imageSource } from '../api/shop';
import ShopEditor from '../components/ShopEditor';
import Permit from '../components/Permit';
import { can } from '../permissions/access';
import { useViewer } from '../auth';
import { empty, label, PageTitle, QueryError, Refresh } from '../components/shared';
import '../styles/shop.css';

export default function Shop() {
  const viewer = useViewer();
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<ShopItem | 'create' | null>(null);
  const [deleting, setDeleting] = useState<ShopItem | null>(null);
  const client = useQueryClient();
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: ['shop'],
    queryFn: ({ signal }) => request<{ items: ShopItem[] }>('/api/admin/shop', { signal }),
  });
  const toggle = useMutation({
    mutationFn: (row: ShopItem) => post(`/api/admin/shop/${row.id}`, { enabled: !row.enabled }),
    onSuccess: async (data) => {
      void message.success(data.msg || '商品状态已更新');
      await client.invalidateQueries({ queryKey: ['shop'] });
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  const remove = useMutation({
    mutationFn: (row: ShopItem) =>
      request<{ msg: string }>(`/api/admin/shop/${row.id}`, { method: 'DELETE' }),
    onSuccess: async (data) => {
      void message.success(data.msg || '商品已删除');
      setDeleting(null);
      await client.invalidateQueries({ queryKey: ['shop'] });
    },
  });
  const rows = (query.data?.items || []).filter(
    (row) =>
      (!category || row.category === category) &&
      `${row.name} ${row.code || ''}`.toLowerCase().includes(keyword.toLowerCase()),
  );
  useEffect(() => {
    const last = Math.max(1, Math.ceil(rows.length / 10));
    if (page > last) setPage(last);
  }, [rows.length, page]);
  const busy = toggle.isPending || remove.isPending;
  return (
    <>
      <PageTitle
        title="商品管理"
        description="管理商品图片、销售资料、库存和上架状态。"
        extra={
          <>
            <Refresh run={query.refetch} loading={query.isFetching} />
            <Permit permission="points.recharge">
              <Link to="/recharge">
                <Button>冠军币充值</Button>
              </Link>
            </Permit>
            <Permit permission="shop.create">
              <Button
                type="primary"
                icon={<PlusOutlined />}
                aria-label="新建商品"
                onClick={() => setEditor('create')}
              >
                新建商品
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
              aria-label="搜索商品"
              placeholder="搜索商品名称或编码"
              allowClear
              style={{ width: 280 }}
              onSearch={(value) => {
                setKeyword(value);
                setPage(1);
              }}
            />
            <Select
              aria-label="商品分类"
              virtual={false}
              value={category}
              style={{ width: 150 }}
              onChange={(value) => {
                setCategory(value);
                setPage(1);
              }}
              options={[
                { value: '', label: '全部分类' },
                ...[...new Set(query.data?.items.map((row) => row.category))].map((value) => ({
                  value,
                  label: label(value),
                })),
              ]}
            />
          </Space>
        </div>
        <Table<ShopItem>
          rowKey="id"
          dataSource={rows}
          loading={query.isPending}
          locale={{ emptyText: empty }}
          scroll={{ x: 1150 }}
          pagination={{
            current: page,
            onChange: setPage,
            pageSize: 10,
            showTotal: (total) => `共 ${total} 件商品`,
          }}
          columns={[
            {
              title: '图片',
              width: 70,
              dataIndex: 'icon',
              render: (value: string) =>
                imageSource(value) ? (
                  <img className="shop-icon" src={value} alt="" />
                ) : (
                  <span>{value || '—'}</span>
                ),
            },
            {
              title: '商品名称',
              width: 265,
              render: (_, row) => (
                <div className="cell-title">
                  {row.name}
                  <small>
                    #{row.id} · {row.description || '暂无描述'}
                  </small>
                  {(row.eligibleMinUserId != null || row.eligibleMaxUserId != null) && (
                    <Tag color="gold">限定领取</Tag>
                  )}
                </div>
              ),
            },
            { title: '分类', dataIndex: 'category', render: label },
            { title: '价格', dataIndex: 'price', render: (value) => `${value} 冠军币` },
            {
              title: '有效期',
              dataIndex: 'durationDays',
              render: (value) => (value == null ? '永久' : `${value} 天`),
            },
            {
              title: '库存',
              dataIndex: 'stock',
              render: (value) => (value == null ? '不限' : value),
            },
            {
              title: '状态',
              dataIndex: 'enabled',
              render: (value) => (
                <Tag bordered={false} color={value ? 'green' : 'default'}>
                  {value ? '已上架' : '已下架'}
                </Tag>
              ),
            },
            {
              title: '操作',
              width: 230,
              render: (_, row) => (
                <Space wrap>
                  <Permit permission="shop.update">
                    <Button type="link" disabled={busy} onClick={() => setEditor(row)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title={`确认${row.enabled ? '下架' : '上架'}「${row.name}」？`}
                      onConfirm={() => toggle.mutateAsync(row).catch(() => undefined)}
                    >
                      <Button type="link" disabled={busy}>
                        {row.enabled ? '下架' : '上架'}
                      </Button>
                    </Popconfirm>
                  </Permit>
                  <Permit permission="shop.delete">
                    <Button
                      type="link"
                      danger
                      disabled={busy}
                      onClick={() => {
                        remove.reset();
                        setDeleting(row);
                      }}
                    >
                      删除
                    </Button>
                  </Permit>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {editor && (
        <ShopEditor
          key={editor === 'create' ? 'create' : editor.id}
          item={editor === 'create' ? undefined : editor}
          onClose={() => setEditor(null)}
        />
      )}
      <Modal
        title="删除商品"
        open={deleting !== null}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: !can(viewer, 'shop.delete') }}
        confirmLoading={remove.isPending}
        cancelButtonProps={{ disabled: remove.isPending }}
        closable={!remove.isPending}
        maskClosable={!remove.isPending}
        onCancel={() => {
          if (!remove.isPending) setDeleting(null);
        }}
        onOk={() => {
          if (deleting && !remove.isPending && can(viewer, 'shop.delete')) remove.mutate(deleting);
        }}
      >
        <p>
          确认删除「{deleting?.name}」（#{deleting?.id}）？
        </p>
        <p>删除后商城不再展示，用户已购背包记录保留。</p>
        {remove.error && (
          <Alert type="error" showIcon title="删除未完成" description={remove.error.message} />
        )}
      </Modal>
    </>
  );
}
