import { useState } from 'react';
import { Card, Input, Table } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { request } from '../api/client';
import type { Season } from '../api/types';
import { dateText, empty, PageTitle, QueryError, Refresh, Status } from '../components/shared';

export default function Seasons() {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['seasons'],
    queryFn: ({ signal }) => request<{ seasons: Season[] }>('/api/admin/season/list', { signal }),
  });
  return (
    <>
      <PageTitle
        title="战队赛事"
        description="查看战队赛进度、队伍规模和报名情况。"
        extra={<Refresh run={query.refetch} loading={query.isFetching} />}
      />
      <QueryError error={query.error} retry={query.refetch} />
      <Card className="content-card">
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
        </div>
        <Table<Season>
          rowKey="id"
          dataSource={query.data?.seasons.filter((row) =>
            row.name.toLowerCase().includes(keyword.toLowerCase()),
          )}
          loading={query.isPending}
          locale={{ emptyText: empty }}
          scroll={{ x: 800 }}
          pagination={{ current: page, onChange: setPage }}
          columns={[
            {
              title: '赛事名称',
              dataIndex: 'name',
              render: (_, row) => (
                <div className="cell-title">
                  {row.name}
                  <small>#{row.id}</small>
                </div>
              ),
            },
            { title: '阶段', dataIndex: 'status', render: (value) => <Status value={value} /> },
            { title: '战队数', dataIndex: 'team_count' },
            { title: '对局数', dataIndex: 'match_count' },
            { title: '报名人数', dataIndex: 'signup_count' },
            { title: '开始时间', dataIndex: 'start_date', render: dateText },
          ]}
        />
      </Card>
    </>
  );
}
