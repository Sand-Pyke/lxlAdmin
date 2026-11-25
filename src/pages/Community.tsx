import { useState } from 'react';
import { App, Button, Card, Popconfirm, Space, Table, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { params, request } from '../api/client';
import { dateText, QueryError, Refresh, tableScrollY } from '../components/shared';

type Comment = { id: number; content: string; created_at: string };
type Post = Comment & { comments: Comment[] };

export default function Community() {
  const [page, setPage] = useState(1);
  const { message } = App.useApp();
  const client = useQueryClient();
  const posts = useQuery({
    queryKey: ['community-posts', page],
    queryFn: ({ signal }) =>
      request<{ posts: Post[]; total: number }>(
        `/api/admin/community?${params({ page: page - 1, pageSize: 10 })}`,
        { signal },
      ),
  });
  const remove = useMutation({
    mutationFn: (id: number) => request(`/api/admin/community/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      void message.success('已删除');
      await client.invalidateQueries({ queryKey: ['community-posts'] });
    },
    onError: (error) => void message.error(error.message),
  });
  const deleteButton = (item: Comment, post = false) => (
    <Popconfirm
      title={post ? '删除帖子及其回复？' : '删除这条回复？'}
      onConfirm={() => remove.mutateAsync(item.id).catch(() => undefined)}
    >
      <Button type="link" danger disabled={remove.isPending}>
        删除{post ? '帖子' : '回复'}
      </Button>
    </Popconfirm>
  );
  return (
    <div className="table-page">
      <QueryError error={posts.error} retry={posts.refetch} />
      <Card className="content-card table-card">
        <div className="table-toolbar">
          <Refresh run={posts.refetch} loading={posts.isFetching} />
        </div>
        <Table<Post>
          rowKey="id"
          dataSource={posts.data?.posts}
          loading={posts.isPending}
          scroll={{ x: 560, y: tableScrollY }}
          pagination={{
            current: page,
            pageSize: 10,
            showSizeChanger: false,
            total: posts.data?.total,
            onChange: setPage,
          }}
          expandable={{
            rowExpandable: (item) => item.comments.length > 0,
            expandedRowRender: (item) => (
              <Space orientation="vertical" style={{ width: '100%' }}>
                {item.comments.map((comment) => (
                  <div key={comment.id}>
                    <Typography.Text>{comment.content}</Typography.Text>
                    {deleteButton(comment)}
                  </div>
                ))}
              </Space>
            ),
          }}
          columns={[
            {
              title: '帖子',
              dataIndex: 'content',
              render: (content: string) => (
                <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content}</span>
              ),
            },
            { title: '回复', width: 80, render: (_, item) => item.comments.length },
            { title: '发布时间', width: 190, dataIndex: 'created_at', render: dateText },
            { title: '操作', width: 120, render: (_, item) => deleteButton(item, true) },
          ]}
        />
      </Card>
    </div>
  );
}
