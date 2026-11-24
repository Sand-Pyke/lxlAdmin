import { Alert, Button, Empty, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';

export function PageTitle({
  title,
  description,
  extra,
}: {
  title: string;
  description: string;
  extra?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <Typography.Title level={2}>{title}</Typography.Title>
        <p>{description}</p>
      </div>
      <Space wrap>{extra}</Space>
    </div>
  );
}
export function QueryError({ error, retry }: { error: Error | null; retry: () => unknown }) {
  return error ? (
    <Alert
      className="query-error"
      type="error"
      showIcon
      title="数据加载失败"
      description={error.message}
      action={<Button onClick={() => retry()}>重试</Button>}
    />
  ) : null;
}
export function Refresh({ run, loading }: { run: () => unknown; loading?: boolean }) {
  return (
    <Button icon={<ReloadOutlined />} loading={loading} onClick={() => run()}>
      刷新
    </Button>
  );
}
const labels: Record<string, string> = {
  PENDING: '待审核',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
  CREATED: '待选人',
  LIVE: '进行中',
  FINISHED: '已结束',
  SIGNUPS: '报名中',
  DRAFTING: '组队中',
  POINTS: '积分赛',
  SWISS: '瑞士轮',
  PLAYOFFS: '淘汰赛',
  FINAL: '决赛',
  TOP: '上单',
  JUG: '打野',
  MID: '中单',
  ADC: '下路',
  SUP: '辅助',
  TITLE: '称号',
  AVATAR_FRAME: '头像框',
  BACKGROUND: '背景',
  THEME: '主题',
  ITEM_CARD: '道具卡',
  NAMEPLATE: '铭牌',
};
export const label = (value?: string | null) => (value ? labels[value] || value : '未设置');
export function Status({ value }: { value: string }) {
  const color = ['APPROVED', 'LIVE'].includes(value)
    ? 'green'
    : ['PENDING', 'SIGNUPS', 'CREATED'].includes(value)
      ? 'gold'
      : value === 'REJECTED'
        ? 'red'
        : 'default';
  return (
    <Tag color={color} bordered={false}>
      {label(value)}
    </Tag>
  );
}
export const dateText = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12: false,
      }).format(new Date(value))
    : '未排期';
export const empty = (
  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的数据" />
);
