import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  CalendarOutlined,
  EditOutlined,
  ReloadOutlined,
  SwapOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { post } from '../api/client';
import {
  DIVISION_LABEL,
  fetchSeasonBoard,
  groupByScheduleSlot,
  seasonMatchStageLabel,
  type SeasonMatch,
} from '../api/seasons';
import { useViewer } from '../auth';
import { QueryError, Refresh, Status, dateText } from '../components/shared';
import SeasonTeams from '../components/SeasonTeams';
import SeasonLineup from '../components/SeasonLineup';

const TIME_ZONE = 'Asia/Shanghai';
function beijingLocalInput(iso: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}T${parts.get('hour')}:${parts.get('minute')}`;
}

export default function SeasonManage() {
  const { id = '' } = useParams();
  const seasonId = Number(id);
  const viewer = useViewer();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { message } = App.useApp();
  const isCoreAdmin = Boolean(viewer?.is_core_admin);

  const [scoreMatchId, setScoreMatchId] = useState<number | null>(null);
  const [lineupMatchId, setLineupMatchId] = useState<number | null>(null);
  const [scoreOne, setScoreOne] = useState(0);
  const [scoreTwo, setScoreTwo] = useState(0);
  const [scheduleMatchId, setScheduleMatchId] = useState<number | null>(null);
  const [scheduleValue, setScheduleValue] = useState('');
  const [swapMatchId, setSwapMatchId] = useState<number | null>(null);
  const [swapTargetId, setSwapTargetId] = useState<number | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairForm, setPairForm] = useState<
    { matchId: number; teamOneId: number | null; teamTwoId: number | null }[]
  >([]);
  const [prizeOpen, setPrizeOpen] = useState(false);
  const [prizeForm, setPrizeForm] = useState<Record<number, number>>({});

  const boardQuery = useQuery({
    queryKey: ['season-board', seasonId],
    queryFn: ({ signal }) => fetchSeasonBoard(seasonId),
    enabled: Number.isInteger(seasonId) && seasonId > 0,
  });
  const board = boardQuery.data;

  const invalidate = () => client.invalidateQueries({ queryKey: ['season-board', seasonId] });
  const run = useMutation({
    mutationFn: (payload: { url: string; body?: unknown; fallback: string }) =>
      post<{ msg?: string }>(payload.url, payload.body),
    onSuccess: (data, payload) => {
      void message.success(data.msg || payload.fallback);
      void invalidate();
    },
    onError: (error) => void message.error(error.message),
  });

  const isDrafting = board?.season.status === 'DRAFTING';
  const teamCount = board?.teams.length ?? 0;
  const pointsAllDone =
    (board?.matches ?? []).filter(
      (match) => match.phase === 'POINTS' && match.status !== 'FINISHED',
    ).length === 0;
  const swissMatches = useMemo(
    () => (board?.matches ?? []).filter((match) => match.phase === 'SWISS'),
    [board],
  );
  const swissRound = swissMatches.length ? Math.max(...swissMatches.map((m) => m.round_no)) : 0;
  const swissRoundDone =
    swissMatches.length > 0 &&
    swissMatches
      .filter((match) => match.round_no === swissRound)
      .every((m) => m.status === 'FINISHED');
  const swissStandingsRows = board?.swiss_standings ?? [];
  const swissQualifiedCount = swissStandingsRows.filter((row) => row.wins >= 3).length;
  const swissEliminatedCount = swissStandingsRows.filter((row) => row.losses >= 3).length;
  const swissActiveCount = swissStandingsRows.filter(
    (row) => row.wins < 3 && row.losses < 3,
  ).length;
  const swissFinished = swissRoundDone && swissActiveCount === 0 && swissQualifiedCount === 4;

  const playoffMatches = (board?.matches ?? []).filter((match) => match.phase === 'PLAYOFF');
  const semifinals = playoffMatches.filter((match) => match.stage === 'SEMIFINAL');
  const hasFinal = playoffMatches.some((match) => match.stage === 'FINAL');
  const semifinalsDone = semifinals.length > 0 && semifinals.every((m) => m.status === 'FINISHED');
  const nirvanaSemifinals = playoffMatches.filter((match) => match.stage === 'NIRVANA_SEMIFINAL');
  const nirvanaSemifinalsDone =
    nirvanaSemifinals.length === 2 && nirvanaSemifinals.every((m) => m.status === 'FINISHED');

  const divisionByTeamId = useMemo(() => {
    const map = new Map<number, string>();
    for (const team of board?.teams ?? []) map.set(team.id, team.division);
    return map;
  }, [board]);

  const championTeam =
    board?.season.status === 'FINISHED'
      ? (board.teams.find((team) => team.final_rank === 1) ?? null)
      : null;

  const scheduleSections = useMemo(() => {
    const isNirvanaMatch = (match: SeasonMatch) =>
      match.phase === 'POINTS' || match.stage === 'NIRVANA_SEMIFINAL';
    const all = board?.matches ?? [];
    return [
      { key: 'nirvana', label: '涅槃组', matches: all.filter(isNirvanaMatch) },
      { key: 'apex', label: '登峰组', matches: all.filter((match) => !isNirvanaMatch(match)) },
    ]
      .filter((section) => section.matches.length > 0)
      .map((section) => ({ ...section, groups: groupByScheduleSlot(section.matches) }));
  }, [board]);

  const nirvanaPairTeams = (board?.teams ?? []).filter((team) =>
    nirvanaSemifinals.some((m) => m.team_one_id === team.id || m.team_two_id === team.id),
  );

  function openScore(match: SeasonMatch) {
    setScoreMatchId(match.id);
    setScoreOne(match.score_one);
    setScoreTwo(match.score_two);
  }
  function openSchedule(match: SeasonMatch) {
    setScheduleMatchId(match.id);
    setScheduleValue(match.scheduled_at ? beijingLocalInput(match.scheduled_at) : '');
  }
  function openSwap(match: SeasonMatch) {
    setSwapMatchId(match.id);
    setSwapTargetId(null);
  }
  function openNirvanaPairing() {
    setPairForm(
      nirvanaSemifinals.map((match) => ({
        matchId: match.id,
        teamOneId: match.team_one_id,
        teamTwoId: match.team_two_id,
      })),
    );
    setPairOpen(true);
  }
  function openPrize() {
    if (!board) return;
    const form: Record<number, number> = { 1: 0, 2: 0, 4: 0, 8: 0 };
    try {
      const current = JSON.parse(board.season.prize_pool_json || '{}') as Record<string, unknown>;
      for (const key of ['1', '2', '4', '8']) {
        const amount = Number(current[key] ?? 0);
        form[Number(key)] = Number.isFinite(amount) ? amount : 0;
      }
    } catch {
      /* keep defaults */
    }
    setPrizeForm(form);
    setPrizeOpen(true);
  }

  if (!Number.isInteger(seasonId) || seasonId <= 0) {
    return (
      <Alert
        type="error"
        showIcon
        title="赛事编号无效"
        action={<Button href="/seasons">返回列表</Button>}
      />
    );
  }

  const scoreMatch =
    scoreMatchId !== null
      ? (board?.matches ?? []).find((match) => match.id === scoreMatchId)
      : null;
  const scheduleMatch =
    scheduleMatchId !== null
      ? (board?.matches ?? []).find((match) => match.id === scheduleMatchId)
      : null;
  const lineupMatch = board?.matches.find((match) => match.id === lineupMatchId);

  return (
    <>
      <div className="page-title">
        <div>
          <Typography.Title level={2}>战队赛管理</Typography.Title>
          <p>
            <Link to="/seasons">战队赛事</Link> ·{' '}
            {board ? `${board.season.name}（#${seasonId}）` : '加载中…'}
          </p>
        </div>
        <Space wrap>
          <Refresh run={boardQuery.refetch} loading={boardQuery.isFetching} />
          <Button onClick={() => navigate('/seasons')}>返回列表</Button>
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
                <Status value={board.season.status} />
                {board.season.start_date ? (
                  <Typography.Text type="secondary">
                    {dateText(board.season.start_date)}
                  </Typography.Text>
                ) : null}
                {championTeam ? (
                  <Tag color="gold" icon={<TrophyOutlined />}>
                    周冠军：{championTeam.name}
                    {championTeam.abbr ? `（${championTeam.abbr}）` : ''}
                  </Tag>
                ) : null}
              </Space>

              {isCoreAdmin ? (
                <Space wrap>
                  <Typography.Text type="secondary">开赛与晋级</Typography.Text>
                  {isDrafting ? (
                    <>
                      <Button
                        size="small"
                        disabled={teamCount < 2}
                        loading={run.isPending}
                        onClick={() =>
                          run.mutate({
                            url: `/api/admin/season/group`,
                            body: { seasonId },
                            fallback: '已按首发费用分组',
                          })
                        }
                      >
                        按费用分组
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        loading={run.isPending}
                        onClick={() =>
                          run.mutate({
                            url: `/api/admin/season/lock`,
                            body: { seasonId },
                            fallback: '名单已锁定，赛程已生成',
                          })
                        }
                      >
                        锁定名单并生成赛程
                      </Button>
                    </>
                  ) : null}
                  {board.matches.length ? (
                    <Popconfirm
                      title="修正赛程时间？"
                      description="按本届起始日期修正为北京时间，不影响对阵、比分、战绩或阵容。"
                      okText="确认修正"
                      cancelText="取消"
                      onConfirm={() =>
                        run.mutate({
                          url: `/api/admin/season/reschedule`,
                          body: { seasonId },
                          fallback: '赛程时间已修正',
                        })
                      }
                    >
                      <Button size="small" icon={<CalendarOutlined />} loading={run.isPending}>
                        修正赛程时间
                      </Button>
                    </Popconfirm>
                  ) : null}
                  {board.season.status === 'POINTS' && pointsAllDone ? (
                    <Button
                      size="small"
                      type="primary"
                      loading={run.isPending}
                      onClick={() =>
                        run.mutate({
                          url: `/api/admin/season/nirvana-playoffs`,
                          body: { seasonId },
                          fallback: '涅槃组四强已生成',
                        })
                      }
                    >
                      生成涅槃组四强（BO5）
                    </Button>
                  ) : null}
                  {board.season.status === 'PLAYOFFS' &&
                  nirvanaSemifinalsDone &&
                  !swissMatches.length ? (
                    <Button
                      size="small"
                      type="primary"
                      loading={run.isPending}
                      onClick={() =>
                        run.mutate({
                          url: `/api/admin/season/swiss/start`,
                          body: { seasonId },
                          fallback: '瑞士轮第 1 轮已生成',
                        })
                      }
                    >
                      开始瑞士轮
                    </Button>
                  ) : null}
                  {board.season.status === 'SWISS' && swissRoundDone && swissActiveCount > 0 ? (
                    <Button
                      size="small"
                      type="primary"
                      loading={run.isPending}
                      onClick={() =>
                        run.mutate({
                          url: `/api/admin/season/swiss/advance`,
                          body: { seasonId },
                          fallback: '瑞士轮已推进',
                        })
                      }
                    >
                      瑞士轮下一轮
                    </Button>
                  ) : null}
                  {board.season.status === 'SWISS' && swissFinished ? (
                    <Button
                      size="small"
                      type="primary"
                      loading={run.isPending}
                      onClick={() =>
                        run.mutate({
                          url: `/api/admin/season/playoffs`,
                          body: { seasonId },
                          fallback: '已进入淘汰赛',
                        })
                      }
                    >
                      进入半决赛
                    </Button>
                  ) : null}
                  {board.season.status === 'PLAYOFFS' && semifinals.length > 0 && !hasFinal ? (
                    <Button
                      size="small"
                      type="primary"
                      disabled={!semifinalsDone}
                      loading={run.isPending}
                      onClick={() =>
                        run.mutate({
                          url: `/api/admin/season/final`,
                          body: { seasonId },
                          fallback: '决赛与季军赛已生成',
                        })
                      }
                    >
                      生成决赛与季军赛
                    </Button>
                  ) : null}
                </Space>
              ) : null}

              {board.season.status === 'SWISS' && swissMatches.length > 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  瑞士轮为 BO3：赢 3 场晋级，输 3 场淘汰。当前已晋级 {swissQualifiedCount} 支 /
                  已淘汰 {swissEliminatedCount} 支 / 待定 {swissActiveCount} 支
                </Typography.Text>
              ) : null}
            </Space>
          </Card>

          <Card className="content-card" title={`赛程与战果（${board.matches.length} 场）`}>
            {isCoreAdmin && board.matches.some((m) => m.status !== 'FINISHED') ? (
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
              >
                可对未结束的场次调整开赛时间或交换赛程位置。
              </Typography.Text>
            ) : null}
            {swissStandingsRows.length ? (
              <Space wrap style={{ marginBottom: 12 }}>
                {swissStandingsRows.map((row) => (
                  <Tag
                    key={row.team_id}
                    color={row.wins >= 3 ? 'green' : row.losses >= 3 ? 'red' : 'default'}
                  >
                    {row.name} {row.wins}-{row.losses}
                    {row.wins >= 3 ? ' · 已晋级四强' : row.losses >= 3 ? ' · 已淘汰' : ''}
                  </Tag>
                ))}
              </Space>
            ) : null}
            {scheduleSections.length ? (
              <Space orientation="vertical" size={16} style={{ width: '100%' }}>
                {scheduleSections.map((section) => (
                  <div key={section.key}>
                    <Typography.Text strong style={{ fontSize: 14 }}>
                      {section.label}赛程
                    </Typography.Text>
                    {section.key === 'apex' &&
                    nirvanaSemifinals.length === 2 &&
                    nirvanaSemifinals.every((match) => match.status === 'CREATED') &&
                    isCoreAdmin ? (
                      <Button
                        size="small"
                        icon={<SwapOutlined />}
                        style={{ marginInlineStart: 10 }}
                        onClick={openNirvanaPairing}
                      >
                        调整四强对阵
                      </Button>
                    ) : null}
                    {section.groups.map((group) => (
                      <div key={group.key} style={{ marginTop: 8 }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {group.label}
                        </Typography.Text>
                        <div
                          style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 8 }}
                        >
                          {group.matches.map((match) => (
                            <div
                              key={match.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                flexWrap: 'wrap',
                                padding: '8px 12px',
                                border: '1px solid #e5e7eb',
                                borderRadius: 8,
                              }}
                            >
                              <span style={{ minWidth: 130 }}>
                                {match.team_one?.name ?? '待定'}
                                {match.team_one?.abbr ? `（${match.team_one.abbr}）` : ''}
                              </span>
                              <Tag>{match.bo}</Tag>
                              <Tag color="blue">{seasonMatchStageLabel(match)}</Tag>
                              {divisionByTeamId.get(match.team_one_id) ? (
                                <Tag
                                  color={
                                    divisionByTeamId.get(match.team_one_id) === 'APEX'
                                      ? 'volcano'
                                      : 'geekblue'
                                  }
                                >
                                  {DIVISION_LABEL[divisionByTeamId.get(match.team_one_id)!]}
                                </Tag>
                              ) : null}
                              <span style={{ minWidth: 130 }}>
                                {match.team_two?.name ?? '待定'}
                                {match.team_two?.abbr ? `（${match.team_two.abbr}）` : ''}
                              </span>
                              {match.status === 'FINISHED' ? (
                                <Typography.Text strong>
                                  {match.score_one} : {match.score_two}
                                </Typography.Text>
                              ) : (
                                <Typography.Text type="secondary">未打</Typography.Text>
                              )}
                              <Space size={4} style={{ marginInlineStart: 'auto' }}>
                                {isCoreAdmin &&
                                  match.status !== 'FINISHED' &&
                                  !match.score_one &&
                                  !match.score_two &&
                                  match.team_one &&
                                  match.team_two && (
                                    <Button
                                      size="small"
                                      type="link"
                                      onClick={() => setLineupMatchId(match.id)}
                                    >
                                      调整阵容
                                    </Button>
                                  )}
                                {isCoreAdmin &&
                                ['POINTS', 'SWISS', 'PLAYOFFS'].includes(board.season.status) &&
                                match.status !== 'FINISHED' ? (
                                  <Button size="small" type="link" onClick={() => openScore(match)}>
                                    录入战果
                                  </Button>
                                ) : null}
                                {isCoreAdmin && match.status === 'FINISHED' ? (
                                  <Button
                                    size="small"
                                    type="link"
                                    icon={<EditOutlined />}
                                    onClick={() => openScore(match)}
                                  >
                                    修改比分
                                  </Button>
                                ) : null}
                                {isCoreAdmin ? (
                                  <Button
                                    size="small"
                                    type="link"
                                    icon={<CalendarOutlined />}
                                    onClick={() => openSchedule(match)}
                                  >
                                    开赛时间
                                  </Button>
                                ) : null}
                                {isCoreAdmin && match.status !== 'FINISHED' ? (
                                  <Button
                                    size="small"
                                    type="link"
                                    icon={<SwapOutlined />}
                                    onClick={() => openSwap(match)}
                                  >
                                    交换
                                  </Button>
                                ) : null}
                                {isCoreAdmin && match.status === 'FINISHED' ? (
                                  <Popconfirm
                                    title="重置到开赛前？"
                                    description="将清空本场比分与已录入战绩，并恢复到未开赛状态。"
                                    okText="重置"
                                    okButtonProps={{ danger: true }}
                                    cancelText="取消"
                                    onConfirm={() =>
                                      run.mutate({
                                        url: `/api/admin/season/match/reset`,
                                        body: { matchId: match.id },
                                        fallback: '场次已重置到开赛前',
                                      })
                                    }
                                  >
                                    <Button
                                      size="small"
                                      type="link"
                                      danger
                                      icon={<ReloadOutlined />}
                                    >
                                      重置
                                    </Button>
                                  </Popconfirm>
                                ) : null}
                              </Space>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </Space>
            ) : (
              <Empty description="赛程生成后会显示在这里" />
            )}
          </Card>

          <SeasonTeams board={board} core={isCoreAdmin} onChanged={invalidate} />
          {lineupMatch && (
            <SeasonLineup
              key={lineupMatch.id}
              match={lineupMatch}
              teams={board.teams}
              onClose={() => setLineupMatchId(null)}
              onChanged={invalidate}
            />
          )}

          <Card className="content-card" title="冠军池">
            <Space wrap>
              <Button
                size="small"
                disabled={!isCoreAdmin && !['SIGNUPS', 'DRAFTING'].includes(board.season.status)}
                onClick={openPrize}
              >
                设置冠军池
              </Button>
              {board.season.prize_distributed ? <Tag color="green">奖金已发放</Tag> : null}
            </Space>
          </Card>

          <Modal
            title={`录入战果 · ${scoreMatch ? `${scoreMatch.team_one?.name ?? '待定'} vs ${scoreMatch.team_two?.name ?? '待定'}` : ''}`}
            open={scoreMatchId !== null}
            okText={scoreMatch?.status === 'FINISHED' ? '保存比分' : '确认录入'}
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setScoreMatchId(null)}
            onOk={() => {
              if (scoreMatchId === null) return;
              run.mutate(
                {
                  url: `/api/admin/season/match/finish`,
                  body: { matchId: scoreMatchId, scoreOne, scoreTwo },
                  fallback: scoreMatch?.status === 'FINISHED' ? '比分已修改' : '战果已录入',
                },
                { onSuccess: () => setScoreMatchId(null) },
              );
            }}
          >
            <Space size={12}>
              <InputNumber
                min={0}
                max={3}
                value={scoreOne}
                onChange={(v) => setScoreOne(Number(v) || 0)}
              />
              <span>:</span>
              <InputNumber
                min={0}
                max={3}
                value={scoreTwo}
                onChange={(v) => setScoreTwo(Number(v) || 0)}
              />
            </Space>
          </Modal>

          <Modal
            title={`修改开赛时间 · ${scheduleMatch ? `${scheduleMatch.team_one?.name ?? '待定'} vs ${scheduleMatch.team_two?.name ?? '待定'}` : ''}`}
            open={scheduleMatchId !== null}
            okText="保存时间"
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setScheduleMatchId(null)}
            onOk={() => {
              if (scheduleMatchId === null || !scheduleValue) {
                void message.error('请选择开赛时间');
                return;
              }
              run.mutate(
                {
                  url: `/api/admin/season/match/reschedule`,
                  body: { matchId: scheduleMatchId, scheduledAt: scheduleValue.replace('T', ' ') },
                  fallback: '开赛时间已更新',
                },
                { onSuccess: () => setScheduleMatchId(null) },
              );
            }}
          >
            <Space orientation="vertical" size={8} style={{ width: '100%' }}>
              <input
                type="datetime-local"
                value={scheduleValue}
                onChange={(event) => setScheduleValue(event.target.value)}
                style={{ width: '100%' }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                时间按北京时间（UTC+8）保存，不影响比分、战绩或对阵。
              </Typography.Text>
            </Space>
          </Modal>

          <Modal
            title="交换赛程位置"
            open={swapMatchId !== null}
            okText="确认交换"
            cancelText="取消"
            confirmLoading={run.isPending}
            okButtonProps={{ disabled: swapTargetId === null }}
            onCancel={() => setSwapMatchId(null)}
            onOk={() => {
              if (swapMatchId === null || swapTargetId === null) {
                void message.error('请选择要交换的场次');
                return;
              }
              run.mutate(
                {
                  url: `/api/admin/season/match/swap-schedule`,
                  body: { seasonId, sourceMatchId: swapMatchId, targetMatchId: swapTargetId },
                  fallback: '两场赛程已对调',
                },
                { onSuccess: () => setSwapMatchId(null) },
              );
            }}
          >
            <Select
              style={{ width: '100%' }}
              placeholder="选择要交换的另一场未结束比赛"
              value={swapTargetId ?? undefined}
              options={(board.matches ?? [])
                .filter((match) => match.id !== swapMatchId && match.status !== 'FINISHED')
                .map((match) => ({
                  value: match.id,
                  label: `${match.team_one?.name ?? '待定'} vs ${match.team_two?.name ?? '待定'}（${seasonMatchStageLabel(match)}）`,
                }))}
              onChange={setSwapTargetId}
            />
          </Modal>

          <Modal
            title="调整涅槃组四强对阵"
            open={pairOpen}
            okText="保存对阵"
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setPairOpen(false)}
            onOk={() => {
              const flat = pairForm.flatMap((pair) => [pair.teamOneId, pair.teamTwoId]);
              if (flat.some((teamId) => teamId === null)) {
                void message.error('请为每场半决赛选择双方战队');
                return;
              }
              if (new Set(flat).size !== 4) {
                void message.error('四支战队不能重复');
                return;
              }
              run.mutate(
                {
                  url: `/api/admin/season/nirvana-pairing`,
                  body: { seasonId, pairs: pairForm },
                  fallback: '对阵已调整',
                },
                { onSuccess: () => setPairOpen(false) },
              );
            }}
          >
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              {pairForm.map((pair, index) => (
                <div key={pair.matchId} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Select
                    style={{ flex: 1 }}
                    placeholder="战队一"
                    value={pair.teamOneId ?? undefined}
                    options={nirvanaPairTeams.map((team) => ({
                      value: team.id,
                      label: `${team.name}${team.abbr ? `（${team.abbr}）` : ''}`,
                    }))}
                    onChange={(teamOneId) =>
                      setPairForm((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, teamOneId } : item)),
                      )
                    }
                  />
                  <span>vs</span>
                  <Select
                    style={{ flex: 1 }}
                    placeholder="战队二"
                    value={pair.teamTwoId ?? undefined}
                    options={nirvanaPairTeams.map((team) => ({
                      value: team.id,
                      label: `${team.name}${team.abbr ? `（${team.abbr}）` : ''}`,
                    }))}
                    onChange={(teamTwoId) =>
                      setPairForm((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, teamTwoId } : item)),
                      )
                    }
                  />
                </div>
              ))}
            </Space>
          </Modal>

          <Modal
            title={`冠军池 · ${board.season.name}`}
            open={prizeOpen}
            okText="保存"
            cancelText="取消"
            confirmLoading={run.isPending}
            onCancel={() => setPrizeOpen(false)}
            onOk={() =>
              run.mutate(
                {
                  url: `/api/admin/season/prize/${seasonId}`,
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
                title="冠军池在开赛前设置，正式开赛后不可更改（核心管理员不受限）。"
              />
              {([1, 2, 4, 8] as const).map((place) => (
                <div key={place} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Typography.Text style={{ width: 72 }}>
                    {place === 1 ? '冠军' : place === 2 ? '亚军' : place === 4 ? '四强' : '八强'}
                  </Typography.Text>
                  <InputNumber
                    min={0}
                    max={1000000}
                    style={{ width: 180 }}
                    value={prizeForm[place] ?? 0}
                    onChange={(value) =>
                      setPrizeForm((prev) => ({ ...prev, [place]: Number(value ?? 0) }))
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
