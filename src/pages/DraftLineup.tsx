import { Alert, App, Button, Card, Col, Modal, Row, Space, Tag, Result } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { post, request } from '../api/client';
import type { DraftData } from '../components/draft/big-screen-draft';
import { PageTitle, QueryError } from '../components/shared';
import { positionText } from '../data/draft-options';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import { useState } from 'react';

export default function DraftLineup() {
  const { id = '' } = useParams();
  const viewer = useViewer();
  const client = useQueryClient();
  const { message } = App.useApp();
  const [confirm, setConfirm] = useState(false);
  const valid = /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
  const query = useQuery({
    enabled: can(viewer, 'draft.view') && valid,
    queryKey: ['draft-lineup', id],
    queryFn: ({ signal }) => request<DraftData>(`/api/admin/pick/${id}`, { signal }),
  });
  const finish = useMutation({
    mutationFn: () => {
      if (!can(viewer, 'draft.finish')) throw new Error('没有开赛权限');
      return post(`/api/admin/match/finish_pick/${id}`);
    },
    onSuccess: async (result) => {
      setConfirm(false);
      void message.success(result.msg || '赛事已开始');
      await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['matches'] })]);
    },
  });
  const teams = [...(query.data?.board.teams || [])].sort(
    (a, b) => a.sort_order - b.sort_order || a.id - b.id,
  );
  const ready = teams.length >= 2 && teams.every((team) => team.player_count === 5);
  const created = query.data?.board.match.status === 'CREATED';
  if (!can(viewer, 'draft.view')) return <Result status="403" title="没有对阵查看权限" />;
  if (!valid) return <Result status="404" title="赛事编号无效" />;
  return (
    <>
      <PageTitle
        title={query.data ? `${query.data.board.match.name} · 对阵预览` : '对阵预览'}
        description="队伍按已保存的对战顺序展示。实际赛程在结束选人并开赛后由业务服务生成。"
        extra={
          <Space>
            <Link to="/matches">
              <Button>返回赛事管理</Button>
            </Link>
            {created && can(viewer, 'draft.control') && (
              <Link to={`/draft/${id}`}>
                <Button>继续大屏选人</Button>
              </Link>
            )}
            {created && can(viewer, 'draft.finish') && (
              <Button type="primary" disabled={!ready} onClick={() => setConfirm(true)}>
                结束选人并开赛
              </Button>
            )}
          </Space>
        }
      />
      <QueryError error={query.error} retry={query.refetch} />
      {!created && query.data && (
        <Alert
          type="info"
          showIcon
          title="该赛事已开赛或结束，当前显示已保存的队伍名单。"
          style={{ marginBottom: 24 }}
        />
      )}
      <Row gutter={[20, 20]}>
        {teams.map((team, index) => (
          <Col key={team.id} xs={24} md={12}>
            <Card
              title={
                <Space>
                  {team.name}
                  <Tag>第 {index + 1} 位</Tag>
                </Space>
              }
              extra={`${team.player_count}/5 人 · ${team.used_fee} 费`}
            >
              {(query.data?.signs || [])
                .filter((sign) => sign.team_id === team.id)
                .map((sign) => (
                  <p key={sign.id}>
                    <Tag>{positionText(sign.team_pos || sign.main_pos)}</Tag>
                    {sign.game_name || sign.yy_name || sign.username}
                    {sign.is_captain ? ' · 队长' : ''}
                  </p>
                ))}
            </Card>
          </Col>
        ))}
      </Row>
      <Modal
        open={confirm}
        title="确认结束选人并开赛？"
        okText="确认开赛"
        cancelText="取消"
        confirmLoading={finish.isPending}
        closable={!finish.isPending}
        cancelButtonProps={{ disabled: finish.isPending }}
        onCancel={() => {
          if (!finish.isPending) setConfirm(false);
        }}
        onOk={() => {
          if (!finish.isPending) finish.mutate();
        }}
      >
        <p>服务端将检查队伍、首发和赛制要求，通过后把赛事转为进行中并处理相关道具状态。</p>
        {finish.error && (
          <Alert type="error" showIcon title="开赛未完成" description={finish.error.message} />
        )}
      </Modal>
    </>
  );
}
