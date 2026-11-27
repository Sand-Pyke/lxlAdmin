import { memo, useCallback, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  FullscreenOutlined,
  LinkOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { post } from '../api/client';
import {
  defaultCustomFormat,
  MatchFormatFields,
  type MatchFormatValues,
} from '../components/MatchFormatFields';
import { RosterPanel } from '../components/MatchRoster';
import {
  BO_OPTIONS,
  BO_WINS,
  DEFAULT_PRIZE_POOL,
  MATCH_STATUSES,
  CUSTOM_FORMAT,
  matchTeamLimit,
  matchFormatLabel,
  applicableRegularTiers,
  boForRound,
  boScoreHint,
  fetchMatchBoard,
  isValidBoScore,
  prizePoolFromJson,
  roundLabel,
  submitRoundScores,
  type BoardTeam,
  type MatchBoard,
} from '../api/matches';
import { can } from '../permissions/access';
import { useViewer } from '../auth';
import { QueryError, Refresh, Status, dateText, label } from '../components/shared';
import { teamLogo } from '../data/draft-teams';

const MatchRoster = memo(RosterPanel);

type ScorePair = {
  teamOneId: number;
  teamTwoId: number;
  scoreOne: number;
  scoreTwo: number;
  hasScore: boolean;
  touched: boolean;
};

function beijingDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const beijing = new Date(date.getTime() + 8 * 3600000);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijing.getUTCDate()).padStart(2, '0');
  const hours = String(beijing.getUTCHours()).padStart(2, '0');
  const minutes = String(beijing.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export default function MatchManage() {
  const { id = '' } = useParams();
  const matchId = Number(id);
  const viewer = useViewer();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { message } = App.useApp();
  const isCoreAdmin = Boolean(viewer?.is_core_admin);
  const canDeleteMatch = can(viewer, 'matches.delete');
  const statusGate = (disabled: boolean) => (isCoreAdmin ? false : disabled);

  const [statusOpen, setStatusOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [statusValue, setStatusValue] = useState('CREATED');
  const [liveOpen, setLiveOpen] = useState(false);
  const [liveValue, setLiveValue] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [signupPassword, setSignupPassword] = useState('');
  const [editForm] = Form.useForm<
    MatchFormatValues & { name: string; round: string; captain_position: string; date: string }
  >();
  const [prizeOpen, setPrizeOpen] = useState(false);
  const [prizeForm, setPrizeForm] = useState<Record<number, number>>({});
  const [scoreOpen, setScoreOpen] = useState(false);
  const [scoreEditingRound, setScoreEditingRound] = useState(1);
  const [scorePairs, setScorePairs] = useState<ScorePair[]>([]);
  const [wildcardOpen, setWildcardOpen] = useState(false);
  const [wildcardTeamId, setWildcardTeamId] = useState<number | null>(null);
  const [fmvpOpen, setFmvpOpen] = useState(false);
  const [fmvpUserId, setFmvpUserId] = useState<number | null>(null);

  const boardQuery = useQuery({
    queryKey: ['match-board', matchId],
    queryFn: ({ signal }) => fetchMatchBoard(matchId),
    enabled: Number.isInteger(matchId) && matchId > 0,
  });
  const board = boardQuery.data;
  const canEditFormat = Boolean(
    board &&
    (board.match.status === 'CREATED' || (isCoreAdmin && board.match.bo !== CUSTOM_FORMAT)),
  );

  const invalidate = useCallback(
    () => client.invalidateQueries({ queryKey: ['match-board', matchId] }),
    [client, matchId],
  );

  const run = useMutation({
    mutationFn: (payload: { url: string; body?: unknown; fallback: string }) => {
      if (payload.url.startsWith('/api/admin/match/delete/') && !canDeleteMatch) {
        throw new Error('只有二级管理员及以上可以删除赛事');
      }
      return post<{ msg?: string; advanceError?: string; warning?: string }>(
        payload.url,
        payload.body,
      );
    },
    onSuccess: (data, payload) => {
      void message.success(data.msg || payload.fallback);
      if (typeof data.advanceError === 'string') void message.warning(data.advanceError);
      if (data.warning) void message.warning(data.warning);
      void invalidate();
    },
    onError: (error) => void message.error(error.message),
  });

  function saveSignupPassword(value: string | null) {
    run.mutate(
      {
        url: `/api/admin/match/update/${matchId}`,
        body: { signup_password: value },
        fallback: value === null ? '已开放报名' : '已设置报名密码',
      },
      {
        onSuccess: () => {
          setPasswordOpen(false);
          setSignupPassword('');
        },
      },
    );
  }

  const saveScores = useMutation({
    mutationFn: (input: {
      matchId: number;
      roundNo: number;
      pairs: { teamOneId: number; teamTwoId: number; scoreOne: number; scoreTwo: number }[];
      remaining: number;
      advance: boolean;
    }) => submitRoundScores(input),
    onSuccess: (data) => {
      void message.success(data.msg || '战果已保存');
      if (typeof data.advanceError === 'string') void message.warning(data.advanceError);
      if (data.warning) void message.warning(data.warning);
      void invalidate();
    },
    onError: (error) => void message.error(error.message),
  });

  const teamNameOf = (teamId: number | undefined | null) =>
    board?.teams.find((team) => team.id === teamId)?.name ?? (teamId ? `队伍 #${teamId}` : '');
  const logoOf = (teamId: number) => {
    const team = board?.teams.find((item) => item.id === teamId);
    return teamLogo(team?.name, team?.logo);
  };

  const championTeamId = board?.match.champion_team_id;
  const championTeam = board?.teams.find((team) => team.id === championTeamId);
  const fmvpOptions = (board?.signs ?? [])
    .filter((sign) => Boolean(championTeamId) && sign.team_id === championTeamId)
    .map((sign) => ({
      value: sign.user_id,
      label: `${sign.yy_name || sign.username}（${sign.game_name || '无游戏ID'}）`,
    }));

  const scoreRound = board?.current_round ?? 1;
  const scoreBo = board ? boForRound(board.match.bo, scoreRound, board.match.round_formats) : 'BO1';
  const needsWildcard =
    board &&
    matchTeamLimit(board.match.bo, board.match.custom_team_count) === 6 &&
    scoreRound === 1;
  const wildcardOptions = (board?.round_pairs ?? [])
    .filter((pair) => pair.has_score && pair.score_one !== pair.score_two)
    .map((pair) => {
      const loserId = pair.score_one > pair.score_two ? pair.team_two : pair.team_one;
      const loser = board?.teams.find((team) => team.id === loserId);
      return loser ? { value: loser.id, label: loser.name } : null;
    })
    .filter((option): option is { value: number; label: string } => Boolean(option));

  function openPrize() {
    if (!board) return;
    const current = prizePoolFromJson(board.match.prize_pool_json);
    const form: Record<number, number> = {};
    for (const tier of applicableRegularTiers(
      board.match.bo,
      board.match.custom_team_count || board.match.team_count,
    )) {
      form[tier.place] = current[tier.place] ?? DEFAULT_PRIZE_POOL[tier.place] ?? 0;
    }
    setPrizeForm(form);
    setPrizeOpen(true);
  }

  function openScore() {
    if (!board) return;
    setScoreEditingRound(board.current_round ?? 1);
    setScorePairs(
      (board.round_pairs ?? []).map((pair) => ({
        teamOneId: pair.team_one,
        teamTwoId: pair.team_two,
        scoreOne: pair.score_one,
        scoreTwo: pair.score_two,
        hasScore: pair.has_score,
        touched: false,
      })),
    );
    setScoreOpen(true);
  }

  function openEdit() {
    if (!board) return;
    const current = board.match;
    editForm.setFieldsValue({
      ...defaultCustomFormat,
      name: current.name,
      round: current.round,
      captain_position: current.captain_position ?? '',
      date: current.date ? beijingDateTime(current.date) : '',
      bo: current.bo,
      custom_team_count: current.custom_team_count || defaultCustomFormat.custom_team_count,
      round_formats: current.round_formats?.length
        ? current.round_formats
        : defaultCustomFormat.round_formats,
      min_signup_rank: current.min_signup_rank ?? '',
      allow_item_cards: current.allow_item_cards ?? true,
    });
    setEditOpen(true);
  }

  if (!Number.isInteger(matchId) || matchId <= 0) {
    return (
      <Alert
        type="error"
        showIcon
        title="赛事编号无效"
        action={<Button href="/matches">返回列表</Button>}
      />
    );
  }

  return (
    <>
      <div className="page-title">
        <div>
          <Typography.Title level={2}>赛事管理</Typography.Title>
          <p>
            <Link to="/matches">常规赛事</Link> ·{' '}
            {board ? `${board.match.name}（#${matchId}）` : '加载中…'}
          </p>
        </div>
        <Space wrap>
          <Refresh run={boardQuery.refetch} loading={boardQuery.isFetching} />
          <Button onClick={() => navigate('/matches')}>返回列表</Button>
        </Space>
      </div>
      <QueryError error={boardQuery.error} retry={boardQuery.refetch} />
      {boardQuery.isPending ? (
        <Card className="content-card">
          <div className="loading-state">
            <Spin />
          </div>
        </Card>
      ) : board ? (
        <>
          <Card className="content-card">
            <Space orientation="vertical" size={16} style={{ width: '100%' }}>
              <Space wrap>
                <Typography.Text type="secondary">基础信息</Typography.Text>
                <Status value={board.match.status} />
                <Tag>{matchFormatLabel(board.match.bo)}</Tag>
                {board.match.bo === CUSTOM_FORMAT && (
                  <>
                    <Tag>{(board.match.custom_team_count ?? 0) * 5} 人</Tag>
                    <Tag>{board.match.round_formats?.join(' / ')}</Tag>
                    <Tag>
                      {board.match.allow_item_cards === false ? '禁用道具卡' : '允许道具卡'}
                    </Tag>
                    {board.match.min_signup_rank && <Tag>{board.match.min_signup_rank}及以上</Tag>}
                    {board.match.status === 'CREATED' && (
                      <Tag color={board.match.signup_password_required ? 'gold' : undefined}>
                        {board.match.signup_password_required ? '密码报名' : '公开报名'}
                      </Tag>
                    )}
                  </>
                )}
                <Switch
                  aria-label="赛事计费"
                  checked={board.match.use_fee}
                  checkedChildren="计费"
                  unCheckedChildren="免计费"
                  loading={run.isPending}
                  disabled={statusGate(board.match.status !== 'CREATED')}
                  onChange={(useFee) =>
                    run.mutate({
                      url: `/api/admin/match/set_fee/${matchId}`,
                      body: { useFee },
                      fallback: '选费设置已更新',
                    })
                  }
                />
                <Tag>{board.match.round || '未设置阶段'}</Tag>
                {board.match.captain_position ? (
                  <Tag color="gold">队长分路：{label(board.match.captain_position)}</Tag>
                ) : null}
                <Typography.Text type="secondary">{dateText(board.match.date)}</Typography.Text>
              </Space>

              <Space wrap>
                <Button
                  size="small"
                  disabled={statusGate(board.match.status !== 'CREATED')}
                  onClick={openEdit}
                >
                  编辑赛事
                </Button>
                {board.match.bo === CUSTOM_FORMAT && board.match.status === 'CREATED' && (
                  <Button
                    size="small"
                    onClick={() => {
                      setSignupPassword('');
                      setPasswordOpen(true);
                    }}
                  >
                    报名密码
                  </Button>
                )}
                <Button
                  size="small"
                  disabled={statusGate(board.match.status !== 'CREATED')}
                  onClick={openPrize}
                >
                  冠军池
                </Button>
                {board.match.prize_distributed ? <Tag color="green">奖金已发放</Tag> : null}
                <Button
                  size="small"
                  disabled={statusGate(board.match.status === 'FINISHED')}
                  onClick={() => {
                    setLiveValue(board.match.live_url ?? '');
                    setLiveOpen(true);
                  }}
                >
                  设置直播链接
                </Button>
                {board.match.live_url ? (
                  <Typography.Link href={board.match.live_url} target="_blank" rel="noreferrer">
                    观看直播
                  </Typography.Link>
                ) : null}
                {canDeleteMatch && (
                  <Popconfirm
                    disabled={board.match.status !== 'CREATED'}
                    title={`删除赛事「${board.match.name}」？`}
                    description="该赛事的报名、队伍、轮次与战绩会被一并删除。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() =>
                      run.mutate(
                        { url: `/api/admin/match/delete/${matchId}`, fallback: '比赛已删除' },
                        { onSuccess: () => navigate('/matches') },
                      )
                    }
                  >
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={board.match.status !== 'CREATED'}
                    >
                      删除赛事
                    </Button>
                  </Popconfirm>
                )}
              </Space>

              <Space wrap>
                <Typography.Text type="secondary">状态流转</Typography.Text>
                <Button
                  size="small"
                  type="primary"
                  disabled={statusGate(board.match.status !== 'CREATED')}
                  loading={run.isPending}
                  onClick={() =>
                    run.mutate({
                      url: `/api/admin/match/finish_pick/${matchId}`,
                      fallback: '已结束选人，赛事开始',
                    })
                  }
                >
                  结束选人并开赛
                </Button>
                {isCoreAdmin ? (
                  <Button
                    size="small"
                    loading={run.isPending}
                    onClick={() => {
                      setStatusValue(board.match.status);
                      setStatusOpen(true);
                    }}
                  >
                    设置状态
                  </Button>
                ) : null}
              </Space>

              <Space wrap>
                <Typography.Text type="secondary">对战与战果</Typography.Text>
                <Button
                  size="small"
                  disabled={!board.teams.length || statusGate(board.match.status !== 'LIVE')}
                  onClick={openScore}
                >
                  录入本轮战果
                </Button>
                <Button
                  size="small"
                  disabled={!board.has_score || statusGate(board.match.status !== 'LIVE')}
                  loading={run.isPending}
                  onClick={() => {
                    if (needsWildcard) {
                      setWildcardTeamId(null);
                      setWildcardOpen(true);
                    } else {
                      run.mutate({
                        url: `/api/admin/match/round/end/${matchId}`,
                        body: { roundNo: scoreRound },
                        fallback: '本轮已结束',
                      });
                    }
                  }}
                >
                  {needsWildcard ? '结束首轮并选择晋级队伍' : '结束本轮'}
                </Button>
                <Button
                  size="small"
                  icon={<TrophyOutlined />}
                  disabled={
                    !board.teams.length ||
                    Boolean(board.fmvp) ||
                    statusGate(board.match.status !== 'FINISHED')
                  }
                  onClick={() => {
                    setFmvpUserId(board.fmvp?.user_id ?? null);
                    setFmvpOpen(true);
                  }}
                >
                  今日FMVP
                </Button>
                {board.fmvp ? (
                  <Typography.Text type="secondary">
                    FMVP：{board.fmvp.game_name || board.fmvp.username}
                  </Typography.Text>
                ) : null}
              </Space>

              <Space wrap>
                <Typography.Text type="secondary">选人与对阵</Typography.Text>
                <Button
                  aria-label="大屏选人"
                  size="small"
                  icon={<FullscreenOutlined />}
                  disabled={statusGate(board.match.status !== 'CREATED')}
                  onClick={() => navigate(`/draft/${matchId}`)}
                >
                  大屏选人
                </Button>
                <Button
                  aria-label="大屏选人 2.0"
                  size="small"
                  icon={<FullscreenOutlined />}
                  disabled={board.match.status !== 'CREATED'}
                  onClick={() => navigate(`/draft/${matchId}/v2`)}
                >
                  大屏选人 2.0
                </Button>
                {can(viewer, 'draft.view') ? (
                  <Button
                    size="small"
                    icon={<LinkOutlined />}
                    onClick={() => navigate(`/matches/${matchId}/lineup`)}
                  >
                    查看对阵
                  </Button>
                ) : null}
                {can(viewer, 'draft.control') && (
                  <Button size="small" onClick={() => setRosterOpen((open) => !open)}>
                    {rosterOpen ? '收起队伍管理' : '管理队伍'}
                  </Button>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  共 {board.match.team_count} 支队伍
                </Typography.Text>
              </Space>

              {board.teams.length ? (
                <Space wrap>
                  {board.teams.map((team) => (
                    <Tag key={team.id}>
                      {team.name} · {team.player_count} 人
                      {board.match.use_fee ? ` · 已用 ${team.used_fee}` : ''}
                    </Tag>
                  ))}
                  {board.match.use_fee && board.budget ? (
                    <Tag color="blue">预算 {board.budget}</Tag>
                  ) : null}
                </Space>
              ) : (
                <Typography.Text type="secondary">尚未创建队伍，请先进行大屏选人。</Typography.Text>
              )}
            </Space>
          </Card>
          {rosterOpen && can(viewer, 'draft.control') && (
            <MatchRoster board={board} loading={boardQuery.isFetching} onReload={invalidate} />
          )}

          <Modal
            title={`编辑赛事 · ${board.match.name}`}
            open={editOpen}
            forceRender
            okText="保存"
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setEditOpen(false)}
            onOk={() => editForm.submit()}
          >
            <Form
              form={editForm}
              layout="vertical"
              requiredMark={false}
              disabled={run.isPending}
              onFinish={({ name, round, captain_position, date, ...format }) => {
                const current = board.match;
                const formatChanged =
                  format.bo !== current.bo ||
                  (format.bo === CUSTOM_FORMAT &&
                    (format.custom_team_count !== current.custom_team_count ||
                      format.round_formats?.join() !== current.round_formats?.join() ||
                      format.min_signup_rank !== (current.min_signup_rank ?? '') ||
                      format.allow_item_cards !== (current.allow_item_cards ?? true)));
                run.mutate(
                  {
                    url: `/api/admin/match/update/${matchId}`,
                    body: {
                      name: name.trim(),
                      round: round.trim(),
                      captain_position,
                      date: date ? `${date}:00+08:00` : null,
                      ...(canEditFormat && formatChanged ? format : {}),
                    },
                    fallback: '比赛信息已更新',
                  },
                  { onSuccess: () => setEditOpen(false) },
                );
              }}
            >
              <Form.Item
                name="name"
                label="赛事名称"
                rules={[{ required: true, whitespace: true }]}
              >
                <Input maxLength={100} />
              </Form.Item>
              <Form.Item name="round" label="赛事阶段">
                <Input maxLength={40} />
              </Form.Item>
              {canEditFormat ? (
                <MatchFormatFields
                  form={editForm}
                  legacyFormat={BO_OPTIONS.includes(board.match.bo) ? undefined : board.match.bo}
                  allowCustom={board.match.status === 'CREATED'}
                />
              ) : (
                <Form.Item label="赛制">
                  <Typography.Text>{matchFormatLabel(board.match.bo)}</Typography.Text>
                </Form.Item>
              )}
              <Form.Item name="captain_position" label="队长分路">
                <Select
                  options={[
                    { value: '', label: '不指定（沿用首位入队者为队长）' },
                    ...['TOP', 'JUG', 'MID', 'ADC', 'SUP'].map((value) => ({
                      value,
                      label: label(value),
                    })),
                  ]}
                />
              </Form.Item>
              <Form.Item name="date" label="比赛时间（北京时间）">
                <Input type="datetime-local" />
              </Form.Item>
            </Form>
          </Modal>

          <Modal
            title="报名密码"
            open={passwordOpen}
            onCancel={() => {
              setPasswordOpen(false);
              setSignupPassword('');
            }}
            footer={[
              board.match.signup_password_required && (
                <Button
                  key="open"
                  disabled={run.isPending}
                  onClick={() => saveSignupPassword(null)}
                >
                  关闭密码并开放报名
                </Button>
              ),
              <Button
                key="save"
                type="primary"
                loading={run.isPending}
                disabled={!signupPassword.trim()}
                onClick={() => saveSignupPassword(signupPassword)}
              >
                保存密码
              </Button>,
            ]}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text>
                {board.match.signup_password_required
                  ? '报名密码已开启。可以设置新密码，或直接开放报名。'
                  : '设置密码后，只有输入正确密码的选手才能报名。'}
              </Typography.Text>
              <Input.Password
                aria-label="新报名密码"
                value={signupPassword}
                onChange={(event) => setSignupPassword(event.target.value)}
                autoComplete="new-password"
                placeholder="输入新报名密码"
              />
            </Space>
          </Modal>

          <Modal
            title="设置直播链接"
            open={liveOpen}
            okText="保存"
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setLiveOpen(false)}
            onOk={() =>
              run.mutate(
                {
                  url: `/api/admin/match/live/${matchId}`,
                  body: { liveUrl: liveValue.trim() },
                  fallback: '直播链接已保存',
                },
                { onSuccess: () => setLiveOpen(false) },
              )
            }
          >
            <Input
              placeholder="https://..."
              value={liveValue}
              maxLength={300}
              onChange={(event) => setLiveValue(event.target.value)}
            />
          </Modal>

          <Modal
            title={`设置赛事状态 · ${board.match.name}`}
            open={statusOpen}
            okText="保存状态"
            cancelText="取消"
            confirmLoading={run.isPending}
            okButtonProps={{ disabled: statusValue === board.match.status }}
            onCancel={() => setStatusOpen(false)}
            onOk={() =>
              run.mutate(
                {
                  url: `/api/admin/match/status/${matchId}`,
                  body: { status: statusValue },
                  fallback: '赛事状态已更新',
                },
                { onSuccess: () => setStatusOpen(false) },
              )
            }
          >
            <Space orientation="vertical" size={10} style={{ width: '100%' }}>
              <Select
                style={{ width: '100%' }}
                value={statusValue}
                options={MATCH_STATUSES.map((status) => ({ value: status, label: label(status) }))}
                onChange={setStatusValue}
              />
              <Typography.Text type="secondary">
                此操作只修改赛事状态，不会重置或删除队伍、比分和战绩数据。
              </Typography.Text>
            </Space>
          </Modal>

          <Modal
            title={`录入${roundLabel(scoreRound, board.match.total_rounds, board.match.bo, board.match.custom_team_count)}战果（${scoreBo}）`}
            open={scoreOpen}
            okText="保存"
            cancelText="取消"
            confirmLoading={saveScores.isPending}
            closable={!saveScores.isPending}
            mask={{ closable: !saveScores.isPending }}
            keyboard={!saveScores.isPending}
            cancelButtonProps={{ disabled: saveScores.isPending }}
            width={640}
            onCancel={() => setScoreOpen(false)}
            onOk={() => {
              if (saveScores.isPending) return;
              if (board.current_round !== scoreEditingRound) {
                void message.warning('赛事轮次已变化，请重新打开比分窗口核对对阵');
                return;
              }
              if (!scorePairs.length) {
                void message.error('当前轮次没有可录入的对阵');
                return;
              }
              const editablePairs = scorePairs.filter((pair) => isCoreAdmin || !pair.hasScore);
              if (!editablePairs.length) {
                void message.error('本轮战果已全部录入，不能修改');
                return;
              }
              const pendingPairs = editablePairs.filter((pair) => pair.touched);
              if (!pendingPairs.length) {
                void message.error(
                  editablePairs.some((pair) => pair.hasScore)
                    ? '请先填写要修改的比分'
                    : '请至少录入一组对阵的比分',
                );
                return;
              }
              const invalidPair = pendingPairs.find(
                (pair) => !isValidBoScore(scoreBo, pair.scoreOne, pair.scoreTwo),
              );
              if (invalidPair) {
                void message.error(
                  `${boScoreHint(scoreBo)}（${teamNameOf(invalidPair.teamOneId)} vs ${teamNameOf(invalidPair.teamTwoId)}）`,
                );
                return;
              }
              const savedCount =
                scorePairs.filter((pair) => pair.hasScore).length +
                pendingPairs.filter((pair) => !pair.hasScore).length;
              const remaining = scorePairs.length - savedCount;
              saveScores.mutate(
                {
                  matchId,
                  roundNo: scoreRound,
                  pairs: pendingPairs.map((pair) => ({
                    teamOneId: pair.teamOneId,
                    teamTwoId: pair.teamTwoId,
                    scoreOne: pair.scoreOne,
                    scoreTwo: pair.scoreTwo,
                  })),
                  remaining,
                  advance:
                    board.match.status === 'LIVE' &&
                    !needsWildcard &&
                    !scorePairs.some((pair) => pair.scoreOne === pair.scoreTwo),
                },
                {
                  onSuccess: () => {
                    setScoreOpen(false);
                    if (remaining === 0 && needsWildcard && board.match.status === 'LIVE') {
                      setWildcardTeamId(null);
                      setWildcardOpen(true);
                    }
                  },
                },
              );
            }}
          >
            <Space orientation="vertical" size={10} style={{ width: '100%' }}>
              {!isCoreAdmin && scorePairs.some((pair) => pair.hasScore) ? (
                <Alert type="info" showIcon title="已录入战果的对阵不可修改" />
              ) : null}
              {scorePairs.length > 1 ? (
                <Alert
                  type="info"
                  showIcon
                  title="可以先录入已打完的对阵，全部对阵录入后自动晋级；六队首轮需选择额外晋级队伍，平局需另行处理。"
                />
              ) : null}
              {scorePairs.length ? (
                scorePairs.map((pair, index) => (
                  <div
                    key={`${pair.teamOneId}-${pair.teamTwoId}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}
                  >
                    <span style={{ flex: 1, textAlign: 'right', overflowWrap: 'anywhere' }}>
                      {teamNameOf(pair.teamOneId)}{' '}
                      {logoOf(pair.teamOneId) && (
                        <img
                          src={logoOf(pair.teamOneId)}
                          alt=""
                          width={24}
                          height={24}
                          style={{ objectFit: 'contain', verticalAlign: 'middle' }}
                        />
                      )}
                    </span>
                    <InputNumber
                      min={0}
                      max={BO_WINS[scoreBo] ?? 0}
                      value={pair.scoreOne}
                      disabled={saveScores.isPending || (!isCoreAdmin && pair.hasScore)}
                      onChange={(value) =>
                        setScorePairs((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, scoreOne: Number(value) || 0, touched: true }
                              : item,
                          ),
                        )
                      }
                    />
                    <span>:</span>
                    <InputNumber
                      min={0}
                      max={BO_WINS[scoreBo] ?? 0}
                      value={pair.scoreTwo}
                      disabled={saveScores.isPending || (!isCoreAdmin && pair.hasScore)}
                      onChange={(value) =>
                        setScorePairs((prev) =>
                          prev.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, scoreTwo: Number(value) || 0, touched: true }
                              : item,
                          ),
                        )
                      }
                    />
                    {pair.hasScore ? <Tag color="green">已录入</Tag> : <Tag>待录入</Tag>}
                    <span style={{ flex: 1, overflowWrap: 'anywhere' }}>
                      {logoOf(pair.teamTwoId) && (
                        <img
                          src={logoOf(pair.teamTwoId)}
                          alt=""
                          width={24}
                          height={24}
                          style={{ objectFit: 'contain', verticalAlign: 'middle' }}
                        />
                      )}{' '}
                      {teamNameOf(pair.teamTwoId)}
                    </span>
                  </div>
                ))
              ) : (
                <Alert
                  type="info"
                  showIcon
                  title="当前轮次没有可录入的对阵，请先完成队伍编排并结束选人开赛。"
                />
              )}
            </Space>
          </Modal>

          <Modal
            title="选择第四支半决赛队伍"
            open={wildcardOpen}
            okText="确认晋级"
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setWildcardOpen(false)}
            onOk={() => {
              if (wildcardTeamId === null) {
                void message.error('请选择一支首轮落败队伍');
                return;
              }
              run.mutate(
                {
                  url: `/api/admin/match/round/end/${matchId}`,
                  body: { wildcardTeamId, roundNo: scoreRound },
                  fallback: '半决赛队伍已确定',
                },
                { onSuccess: () => setWildcardOpen(false) },
              );
            }}
          >
            <Space orientation="vertical" size={10} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                title="三场 BO3 的胜者自动晋级。请从三支落败队伍中选一支，补足半决赛四队。"
              />
              <Select
                style={{ width: '100%' }}
                placeholder="选择一支落败队伍"
                value={wildcardTeamId ?? undefined}
                options={wildcardOptions}
                onChange={setWildcardTeamId}
              />
            </Space>
          </Modal>

          <Modal
            title="设置今日 FMVP"
            open={fmvpOpen}
            okText="确定"
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setFmvpOpen(false)}
            okButtonProps={{ disabled: !fmvpOptions.some((option) => option.value === fmvpUserId) }}
            onOk={() => {
              if (!fmvpUserId || !fmvpOptions.some((option) => option.value === fmvpUserId)) {
                void message.error('请选择冠军队伍的 FMVP 选手');
                return;
              }
              run.mutate(
                {
                  url: `/api/admin/match/fmvp/${matchId}`,
                  body: { userId: fmvpUserId },
                  fallback: '今日 FMVP 已设置',
                },
                { onSuccess: () => setFmvpOpen(false) },
              );
            }}
          >
            <Space orientation="vertical" size={10} style={{ width: '100%' }}>
              <Alert type="warning" showIcon title="今日 FMVP 设置后不可更改，请确认所选选手。" />
              {championTeam ? (
                <Typography.Text type="secondary">
                  冠军队伍：{championTeam.name}。仅展示冠军队选手，支持按昵称或游戏 ID 搜索。
                </Typography.Text>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  title="尚未确认冠军队伍，请先完成决赛战果录入并结束赛事。"
                />
              )}
              <Select
                style={{ width: '100%' }}
                placeholder="搜索冠军队选手昵称 / 游戏 ID"
                showSearch
                optionFilterProp="label"
                disabled={!fmvpOptions.length || run.isPending}
                value={fmvpUserId ?? undefined}
                options={fmvpOptions}
                onChange={setFmvpUserId}
              />
            </Space>
          </Modal>

          <Modal
            title={`冠军池 · ${board.match.name}`}
            open={prizeOpen}
            okText="保存"
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setPrizeOpen(false)}
            onOk={() =>
              run.mutate(
                {
                  url: `/api/admin/match/prize/${matchId}`,
                  body: { prize_pool: prizeForm },
                  fallback: '冠军池已保存',
                },
                { onSuccess: () => setPrizeOpen(false) },
              )
            }
          >
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                title="冠军池在开赛前设置，正式开赛后不可更改（核心管理员不受限）。按最终名次给该档每位参赛队员发放对应冠军币。"
              />
              {applicableRegularTiers(
                board.match.bo,
                board.match.custom_team_count || board.match.team_count,
              ).map((tier) => (
                <div key={tier.place} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Typography.Text style={{ width: 72 }}>{tier.label}</Typography.Text>
                  <InputNumber
                    min={0}
                    max={1000000}
                    style={{ width: 180 }}
                    value={prizeForm[tier.place] ?? 0}
                    onChange={(value) =>
                      setPrizeForm((prev) => ({ ...prev, [tier.place]: Number(value ?? 0) }))
                    }
                    suffix="冠军币 / 人"
                  />
                </div>
              ))}
            </Space>
          </Modal>
        </>
      ) : null}
    </>
  );
}
