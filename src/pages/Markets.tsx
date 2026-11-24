import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Drawer,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { params, post, request } from '../api/client';
import {
  gameCount,
  marketRound,
  openMarketBody,
  pairingKey,
  recentMarketDates,
  reopenMarketBody,
} from '../api/markets';
import type { Bet, Market, MarketBets, MarketList, OpenBody } from '../api/markets';
import { dateText, empty, PageTitle, QueryError, Refresh } from '../components/shared';
import '../styles/markets.css';
import Permit from '../components/Permit';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import type { Permission } from '../permissions/access';

const marketStates: Record<string, { label: string; color: string }> = {
  OPEN: { label: '开盘中', color: 'green' },
  CLOSED: { label: '已封盘', color: 'orange' },
  SETTLED: { label: '已结算', color: 'blue' },
  VOID: { label: '已作废', color: 'default' },
};
const betStates: Record<string, { label: string; color: string }> = {
  OPEN: { label: '进行中', color: 'blue' },
  WON: { label: '已中奖', color: 'green' },
  LOST: { label: '未中奖', color: 'default' },
  REFUNDED: { label: '已退款', color: 'orange' },
};
type Action = {
  kind: 'open' | 'reopen' | 'close' | 'settle' | 'void';
  title: string;
  description: string;
  source: string;
  path: string;
  body?: OpenBody | { winnerKey: string };
};

function BetsDrawer({ marketId, onClose }: { marketId: number | null; onClose: () => void }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [marketId]);
  const query = useQuery({
    queryKey: ['market-bets', marketId],
    enabled: marketId !== null,
    queryFn: ({ signal }) => request<MarketBets>(`/api/admin/markets/${marketId}/bets`, { signal }),
    refetchInterval: 10_000,
  });
  return (
    <Drawer
      title={
        query.data
          ? `下注明细 · ${query.data.market.source.name} · ${marketRound(query.data.market)}`
          : '下注明细'
      }
      open={marketId !== null}
      onClose={onClose}
      size={900}
      styles={{ wrapper: { maxWidth: '100vw' } }}
    >
      <QueryError error={query.error} retry={query.refetch} />
      <Refresh run={query.refetch} loading={query.isFetching} />
      {query.data && (
        <>
          <p className="muted">
            {query.data.market.source.pair || ''} · 每 10 秒刷新；接口最多返回最近 1,000
            笔，以下统计以返回记录为准。
          </p>
          <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
            <Col xs={24} sm={12}>
              <Card>
                <Statistic title="记录下注总额" value={query.data.totalPool} suffix="冠军币" />
              </Card>
            </Col>
            <Col xs={24} sm={12}>
              <Card>
                <Statistic title="下注笔数" value={query.data.totalBets} />
              </Card>
            </Col>
          </Row>
          <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
            {query.data.outcomes.map((outcome) => (
              <Col xs={24} sm={12} key={outcome.id}>
                <Card size="small" title={outcome.label}>
                  <Space wrap>
                    <span>{outcome.betCount} 注</span>
                    <span>{outcome.totalStake} 冠军币</span>
                    <span>当前赔率 {outcome.odds.toFixed(2)}</span>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        </>
      )}
      <Table<Bet>
        rowKey="id"
        dataSource={query.data?.bets}
        loading={query.isPending && marketId !== null}
        locale={{ emptyText: empty }}
        scroll={{ x: 940 }}
        pagination={{
          current: page,
          onChange: setPage,
          pageSize: 10,
          showTotal: (total) => `共 ${total} 笔`,
        }}
        columns={[
          {
            title: '用户',
            render: (_, row) => (
              <div className="cell-title">
                {row.gameName || row.username}
                <small>
                  {row.username} · UID {row.userId}
                </small>
              </div>
            ),
          },
          { title: '下注选项', dataIndex: 'outcomeLabel' },
          { title: '下注金额', dataIndex: 'stake' },
          {
            title: '下注赔率',
            dataIndex: 'odds_at_bet',
            render: (value: number) => value.toFixed(2),
          },
          { title: '预计返还', dataIndex: 'potential_payout' },
          { title: '实际返还', dataIndex: 'settled_payout' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (value: string) => (
              <Tag color={betStates[value]?.color}>{betStates[value]?.label || value}</Tag>
            ),
          },
          { title: '下注时间', dataIndex: 'createdAt', render: dateText },
        ]}
      />
    </Drawer>
  );
}

export default function Markets() {
  const viewer = useViewer();
  const [dates, setDates] = useState<[string, string] | null>(() => recentMarketDates());
  const [draftDates, setDraftDates] = useState<[string, string]>(() => recentMarketDates());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [kind, setKind] = useState<'REGULAR' | 'SEASON'>('REGULAR');
  const [sourceId, setSourceId] = useState<number>();
  const [pair, setPair] = useState<string>();
  const [round, setRound] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const [marketId, setMarketId] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const client = useQueryClient();
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: ['markets', { dates, page, pageSize }],
    queryFn: ({ signal }) =>
      request<MarketList>(
        `/api/admin/markets?${params({ page, pageSize, ...(dates ? { startDate: dates[0], endDate: dates[1] } : { range: 'all' }) })}`,
        { signal },
      ),
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (query.data && query.data.page !== page) setPage(query.data.page);
  }, [query.data, page]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const mutation = useMutation({
    mutationFn: (next: Action) => {
      const permission: Permission =
        next.kind === 'open' || next.kind === 'reopen' ? 'markets.open' : `markets.${next.kind}`;
      if (!can(viewer, permission)) throw new Error('当前账号没有此盘口操作权限');
      return post<{ reused?: boolean }>(next.path, next.body);
    },
    onSuccess: async (_, next) => {
      void message.success(
        {
          open: '盘口已开盘或更新',
          reopen: '盘口已重新开盘',
          close: '盘口已封盘',
          settle: '盘口已结算',
          void: '盘口已作废，本金已退回',
        }[next.kind],
      );
      setAction(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['markets'] }),
        client.invalidateQueries({ queryKey: ['market-bets'] }),
      ]);
    },
  });
  const sources = kind === 'REGULAR' ? query.data?.regular || [] : query.data?.season || [];
  const selected = sources.find((source) => source.id === sourceId);
  const pairs = selected?.pairings || [];
  const selectedPair =
    pairs.find((item) => pairingKey(item) === pair) || (pairs.length === 1 ? pairs[0] : undefined);
  const busy = mutation.isPending;
  const chooseAction = (next: Action) => {
    mutation.reset();
    setAction(next);
  };
  const prepareOpen = () => {
    try {
      const body = openMarketBody(kind, selected, pair, round);
      chooseAction({
        kind: 'open',
        title: '确认开盘 / 更新赔率？',
        source: `${selected!.name}${selectedPair ? ` · ${selectedPair.label}` : ''} · ${round ? `第 ${round} 局` : '大场'}`,
        path: '/api/admin/markets/open',
        body,
        description:
          '将按出场费用生成赔率。新盘口开放 15 分钟；更新仍在开放的盘口不会延长截止时间，已下注订单保留原下注赔率。',
      });
    } catch (error) {
      void message.warning((error as Error).message);
    }
  };
  const prepareRowAction = (
    market: Market,
    next: 'reopen' | 'close' | 'void' | 'settle',
    outcome?: { outcomeKey: string; label: string },
  ) => {
    const source = `${market.source.name}${market.source.pair ? ` · ${market.source.pair}` : ''} · ${marketRound(market)} · #${market.id}`;
    if (next === 'reopen') {
      try {
        chooseAction({
          kind: next,
          title: '确认重新开盘？',
          source,
          path: '/api/admin/markets/open',
          body: reopenMarketBody(market),
          description: '将重新生成赔率并开始新的 15 分钟投注窗口。已有下注订单保留原赔率。',
        });
      } catch (error) {
        void message.warning((error as Error).message);
      }
      return;
    }
    chooseAction({
      kind: next,
      source,
      path: `/api/admin/markets/${market.id}/${next}`,
      title:
        next === 'settle'
          ? `确认结算为「${outcome!.label} 胜」？`
          : next === 'close'
            ? '确认封盘？'
            : '确认作废并退还本金？',
      description:
        next === 'settle'
          ? '结算会按下注时的赔率处理冠军币返还，完成后不能重新开盘。请核对胜方和局次。'
          : next === 'close'
            ? '封盘后不再接受新投注，已有订单保留，等待结算或作废。'
            : '该盘口将停止使用，未结算的投注本金由业务服务退回，完成后不能重新开盘。',
      ...(outcome ? { body: { winnerKey: outcome.outcomeKey } } : {}),
    });
  };
  const applyDates = () => {
    if (!draftDates[0] || !draftDates[1] || draftDates[0] > draftDates[1]) {
      void message.warning('请选择有效的开始和结束日期，开始日期不能晚于结束日期');
      return;
    }
    setDates([...draftDates]);
    setPage(1);
  };
  return (
    <>
      <PageTitle
        title="竞猜管理"
        description="管理赛事盘口、赔率、下注记录和结算。"
        extra={<Refresh run={query.refetch} loading={query.isFetching} />}
      />
      <QueryError error={query.error} retry={query.refetch} />
      <Card className="content-card market-open-card" title="开盘与赔率">
        <div className="market-open-fields">
          <label>
            赛事类型
            <Select
              aria-label="竞猜赛事类型"
              virtual={false}
              value={kind}
              onChange={(value) => {
                setKind(value);
                setSourceId(undefined);
                setPair(undefined);
                setRound(0);
              }}
              options={[
                { value: 'REGULAR', label: '常规赛' },
                { value: 'SEASON', label: '战队赛' },
              ]}
            />
          </label>
          <label>
            选择比赛
            <Select
              aria-label="竞猜比赛"
              virtual={false}
              value={sourceId}
              placeholder="选择待开盘比赛"
              showSearch
              optionFilterProp="label"
              loading={query.isPending}
              onChange={(value) => {
                setSourceId(value);
                setPair(undefined);
                setRound(0);
              }}
              options={sources.map((source) => ({
                value: source.id,
                label: `${source.name}${source.date ? ` · ${dateText(source.date)}` : ''}`,
              }))}
            />
          </label>
          {kind === 'REGULAR' && (
            <label>
              选择对阵
              <Select
                aria-label="竞猜对阵"
                virtual={false}
                value={selectedPair ? pairingKey(selectedPair) : undefined}
                disabled={!selected || !pairs.length}
                placeholder="先选择比赛并确定对阵"
                onChange={setPair}
                options={pairs.map((item) => ({
                  value: pairingKey(item),
                  label: `${item.label} · 第 ${item.roundNo} 轮`,
                }))}
              />
            </label>
          )}
          <label>
            盘口范围
            <Select
              aria-label="竞猜盘口范围"
              virtual={false}
              value={round}
              disabled={kind === 'SEASON' || !selected}
              onChange={setRound}
              options={[
                { value: 0, label: '大场（全场胜负）' },
                ...Array.from(
                  { length: kind === 'REGULAR' ? gameCount(selected?.bo) : 0 },
                  (_, i) => ({ value: i + 1, label: `第 ${i + 1} 局` }),
                ),
              ]}
            />
          </label>
        </div>
        {selected && kind === 'REGULAR' && !pairs.length && (
          <Alert
            type="warning"
            showIcon
            title="该赛事尚未确定对阵，请先完成分队开赛。"
            style={{ marginBottom: 16 }}
          />
        )}
        <Space wrap>
          <Permit permission="markets.open">
            <Button
              type="primary"
              disabled={busy || !selected || query.isError || (kind === 'REGULAR' && !selectedPair)}
              onClick={prepareOpen}
            >
              开盘 / 更新赔率
            </Button>
          </Permit>
          <Typography.Text type="secondary">
            常规赛支持指定对阵及 BO 小场；战队赛仅支持大场。
          </Typography.Text>
        </Space>
        <p className="market-help">
          赔率按出场费用自动生成。开盘 15
          分钟后截止，后台录入比分或单局战绩后由现有业务服务自动结算；未进行的小场及平局大场退还本金。
        </p>
      </Card>
      <Card className="content-card">
        <div className="table-toolbar">
          <Space wrap align="end">
            <label className="market-date">
              创建开始日期（北京时间）
              <Input
                aria-label="盘口开始日期"
                type="date"
                value={draftDates[0]}
                onChange={(event) => setDraftDates([event.target.value, draftDates[1]])}
              />
            </label>
            <label className="market-date">
              创建结束日期（北京时间）
              <Input
                aria-label="盘口结束日期"
                type="date"
                value={draftDates[1]}
                onChange={(event) => setDraftDates([draftDates[0], event.target.value])}
              />
            </label>
            <Button onClick={applyDates}>筛选日期</Button>
            <Button
              onClick={() => {
                const recent = recentMarketDates();
                setDates(recent);
                setDraftDates(recent);
                setPage(1);
              }}
            >
              近两天
            </Button>
            <Button
              onClick={() => {
                setDates(null);
                setDraftDates(['', '']);
                setPage(1);
              }}
            >
              全部日期
            </Button>
          </Space>
          <span className="muted">
            {dates ? `${dates[0]} 至 ${dates[1]}` : '全部日期'} · 每 10 秒刷新
          </span>
        </div>
        <Table<Market>
          rowKey="id"
          dataSource={query.data?.markets}
          loading={query.isPending}
          locale={{ emptyText: empty }}
          scroll={{ x: 1260 }}
          pagination={{
            current: query.data?.page || page,
            pageSize,
            total: query.data?.total || 0,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            showTotal: (total) => `共 ${total} 个盘口`,
            onChange: (next, size) => {
              setPage(size !== pageSize ? 1 : next);
              setPageSize(size);
            },
          }}
          columns={[
            {
              title: '盘口 / 赛事',
              width: 285,
              render: (_, market) => (
                <div className="cell-title">
                  {market.source.name}
                  <small>
                    #{market.id} · {market.source.kind === 'REGULAR' ? '常规赛' : '战队赛'} ·{' '}
                    {marketRound(market)}
                  </small>
                  {market.source.pair && <small>{market.source.pair}</small>}
                </div>
              ),
            },
            {
              title: '状态',
              width: 100,
              render: (_, market) => {
                const state =
                  market.status === 'OPEN' && new Date(market.bettingCloseAt).getTime() <= now
                    ? { color: 'orange', label: '已截止' }
                    : marketStates[market.status];
                return <Tag color={state?.color}>{state?.label || market.status}</Tag>;
              },
            },
            { title: '截止时间', dataIndex: 'bettingCloseAt', width: 185, render: dateText },
            {
              title: '选项 / 当前赔率',
              width: 240,
              render: (_, market) => (
                <Space orientation="vertical">
                  {market.outcomes.map((outcome) => (
                    <span key={outcome.id}>
                      {outcome.label} <strong>{outcome.odds.toFixed(2)}</strong>
                    </span>
                  ))}
                </Space>
              ),
            },
            {
              title: '管理操作',
              width: 450,
              render: (_, market) => (
                <Space wrap>
                  <Button size="small" onClick={() => setMarketId(market.id)}>
                    下注明细
                  </Button>
                  {['OPEN', 'CLOSED'].includes(market.status) && (
                    <>
                      {market.status === 'OPEN' &&
                      new Date(market.bettingCloseAt).getTime() > now ? (
                        <Permit permission="markets.close">
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() => prepareRowAction(market, 'close')}
                          >
                            封盘
                          </Button>
                        </Permit>
                      ) : (
                        <Permit permission="markets.open">
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() => prepareRowAction(market, 'reopen')}
                          >
                            重新开盘
                          </Button>
                        </Permit>
                      )}
                      {market.outcomes.map((outcome) => (
                        <Permit permission="markets.settle" key={outcome.id}>
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() => prepareRowAction(market, 'settle', outcome)}
                          >
                            {outcome.label} 胜
                          </Button>
                        </Permit>
                      ))}
                      <Permit permission="markets.void">
                        <Button
                          size="small"
                          danger
                          disabled={busy}
                          onClick={() => prepareRowAction(market, 'void')}
                        >
                          作废退款
                        </Button>
                      </Permit>
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <BetsDrawer marketId={marketId} onClose={() => setMarketId(null)} />
      <Modal
        title={action?.title}
        open={action !== null}
        okText={
          action?.kind === 'settle'
            ? '确认结算'
            : action?.kind === 'void'
              ? '确认作废退款'
              : '确认执行'
        }
        cancelText="取消"
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
        okButtonProps={{ danger: action?.kind === 'void' || action?.kind === 'settle' }}
        onCancel={() => {
          if (!busy) {
            setAction(null);
            mutation.reset();
          }
        }}
        onOk={() => {
          if (action && !busy) mutation.mutate(action);
        }}
      >
        <Typography.Paragraph strong style={{ marginTop: 20 }}>
          {action?.source}
        </Typography.Paragraph>
        <p>{action?.description}</p>
        {mutation.error && (
          <Alert
            showIcon
            type="error"
            title="未收到操作成功确认"
            description={`${mutation.error.message}。如果请求超时或网络中断，请先刷新盘口状态再决定是否重试。`}
          />
        )}
      </Modal>
    </>
  );
}
