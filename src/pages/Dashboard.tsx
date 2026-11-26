import { matchFormatLabel } from '../api/matches';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Row, Space, Statistic, Table, Tag } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  PlusOutlined,
  TeamOutlined,
  TrophyOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { request } from '../api/client';
import type { MatchesResponse, UsersResponse } from '../api/types';
import { useViewer } from '../auth';
import Permit from '../components/Permit';
import { dateText, empty, QueryError, Refresh, Status } from '../components/shared';

export default function Dashboard() {
  const viewer = useViewer();
  const users = useQuery({
    queryKey: ['users', 'summary'],
    queryFn: ({ signal }) =>
      request<UsersResponse>('/api/admin/users?page=0&pageSize=1', { signal }),
  });
  const matches = useQuery({
    queryKey: ['matches', 'recent'],
    queryFn: ({ signal }) =>
      request<MatchesResponse>('/api/match/list?page=0&pageSize=5&sort=created_desc', { signal }),
  });
  const active = useQuery({
    queryKey: ['matches', 'active-count'],
    queryFn: ({ signal }) =>
      request<MatchesResponse>('/api/match/list?page=0&pageSize=1&scope=active', { signal }),
  });
  const refresh = () => Promise.all([users.refetch(), matches.refetch(), active.refetch()]);
  const count = (value: number | undefined) => (value === undefined ? '—' : value);
  const stats = [
    {
      title: '可管理用户',
      value: users.data?.total,
      icon: <UserOutlined />,
      note: '不含当前账号，按权限统计',
    },
    {
      title: '待审核账号',
      value: users.data?.pending_total,
      icon: <ClockCircleOutlined />,
      note: '等待你处理的账号申请',
    },
    {
      title: '常规赛总数',
      value: matches.data?.total,
      icon: <TrophyOutlined />,
      note: '全部常规赛事',
    },
    {
      title: '未结束赛事',
      value: active.data?.total,
      icon: <TeamOutlined />,
      note: '包含待选人与进行中的赛事',
    },
  ];
  return (
    <div className="dashboard-page">
      <section className="welcome-banner">
        <div>
          <span className="eyebrow">LEAGUE OPERATIONS</span>
          <h2>{viewer.username}，欢迎回来</h2>
          <p>一场好比赛，始于每个细节的有序安排。</p>
          <Space wrap>
            <Refresh
              run={refresh}
              loading={users.isFetching || matches.isFetching || active.isFetching}
            />
            <Permit permission="matches.create">
              <Link to="/matches?create=1">
                <Button icon={<PlusOutlined />} size="large">
                  创建常规赛
                </Button>
              </Link>
            </Permit>
          </Space>
        </div>
        <div className="banner-mark" aria-hidden="true">
          <TrophyOutlined />
          <span>LXL LEAGUE</span>
        </div>
      </section>
      <QueryError error={users.error || matches.error || active.error} retry={refresh} />
      <Row gutter={[18, 18]} className="stat-row">
        {stats.map((stat) => (
          <Col xs={12} xl={6} key={stat.title}>
            <Card className="stat-card">
              <div className="stat-top">
                <span>{stat.title}</span>
                <span className="stat-icon">{stat.icon}</span>
              </div>
              <Statistic
                value={count(stat.value)}
                loading={
                  !users.error &&
                  !matches.error &&
                  !active.error &&
                  (users.isPending || matches.isPending || active.isPending)
                }
              />
              <small>{stat.note}</small>
            </Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[18, 18]}>
        <Col xs={24} xl={16}>
          <Card
            className="content-card"
            size="small"
            title="最近创建的赛事"
            extra={<Link to="/matches">全部赛事</Link>}
          >
            <Table
              rowKey="id"
              size="small"
              tableLayout="fixed"
              pagination={false}
              dataSource={matches.data?.match_list}
              loading={matches.isPending}
              locale={{ emptyText: empty }}
              scroll={{ x: 580 }}
              columns={[
                {
                  title: '赛事名称',
                  dataIndex: 'name',
                  render: (name, row) => (
                    <div className="cell-title">
                      <span className="recent-match-name" title={name}>
                        {name}
                      </span>
                      <small>
                        {matchFormatLabel(row.bo)} · {row.round}
                      </small>
                    </div>
                  ),
                },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 95,
                  render: (value) => <Status value={value} />,
                },
                { title: '排期时间', dataIndex: 'date', width: 165, render: dateText },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card className="content-card" size="small" title="运营待办">
            <Link to="/users?status=PENDING" className="task-link">
              <span className="task-icon">
                <ClockCircleOutlined />
              </span>
              <div>
                <strong>审核新账号</strong>
                <span>查看申请资料并完成审核</span>
              </div>
              <Tag bordered={false} color="gold">
                {count(users.data?.pending_total)}
              </Tag>
            </Link>
            <Link to="/signups" className="task-link">
              <span className="task-icon green">
                <TeamOutlined />
              </span>
              <div>
                <strong>查看赛事报名</strong>
                <span>核对选手分路与候补情况</span>
              </div>
            </Link>
            <Link to="/matches" className="task-link">
              <span className="task-icon blue">
                <TrophyOutlined />
              </span>
              <div>
                <strong>安排联赛赛事</strong>
                <span>查看常规赛状态和比赛排期</span>
              </div>
            </Link>
          </Card>
          <Card className="permission-card">
            <Space align="start">
              <CheckCircleOutlined />
              <div>
                <strong>按你的权限展示工作内容</strong>
                <p>实际操作由业务服务再次校验。账号权限变化后，页面会自动更新。</p>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
