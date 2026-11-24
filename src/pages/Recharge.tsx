import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
} from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, params, post, request } from '../api/client';
import { rechargeBody } from '../api/recharge';
import type { RechargeBody, RechargeResult } from '../api/recharge';
import { MAX_INT } from '../api/shop';
import type { User, UsersResponse } from '../api/types';
import { PageTitle, QueryError } from '../components/shared';
import '../styles/shop.css';

type Draft = { user: User; body: RechargeBody };
export default function Recharge() {
  const [form] = Form.useForm<{ amount: number | null; note: string }>();
  const [search, setSearch] = useState('');
  const [keyword, setKeyword] = useState('');
  const [target, setTarget] = useState<User | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [receipt, setReceipt] = useState<{ user: User; result: RechargeResult } | null>(null);
  const [uncertain, setUncertain] = useState<Draft | null>(null);
  const submitted = useRef(false);
  const { message } = App.useApp();
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const users = useQuery({
    queryKey: ['recharge-users', keyword],
    enabled: Boolean(keyword),
    queryFn: ({ signal }) =>
      request<UsersResponse>(`/api/admin/users?${params({ page: 0, pageSize: 20, keyword })}`, {
        signal,
      }),
  });
  const mutation = useMutation({
    mutationFn: async (next: Draft) => {
      const result = await post<RechargeResult>('/api/admin/points/recharge', next.body);
      if (
        result.user_id !== next.body.userId ||
        result.amount !== next.body.amount ||
        !Number.isSafeInteger(result.balance) ||
        result.balance < 0
      ) {
        throw new ApiError('业务服务返回的到账结果无法核对，请先核实流水', 0);
      }
      return result;
    },
    retry: false,
    onSuccess: (result, next) => {
      setReceipt({ user: next.user, result });
      setDraft(null);
      form.resetFields();
      setTarget(null);
      setSearch('');
      setKeyword('');
      void message.success('充值成功');
    },
    onError: (error, next) => {
      if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) {
        setUncertain(next);
        setDraft(null);
      }
    },
    onSettled: () => {
      submitted.current = false;
    },
  });
  const busy = mutation.isPending;
  const locked = busy || uncertain !== null;
  const prepare = (values: { amount: number | null; note: string }) => {
    try {
      const body = rechargeBody(target?.id, values.amount, values.note);
      if (!target) return;
      setReceipt(null);
      mutation.reset();
      setDraft({ user: target, body });
    } catch (error) {
      void message.warning((error as Error).message);
    }
  };
  return (
    <>
      <PageTitle
        title="冠军币充值"
        description="搜索并核对目标用户，为其充值冠军币。到账通知与流水由业务服务记录。"
      />
      {uncertain && (
        <Alert
          style={{ marginBottom: 24 }}
          showIcon
          type="warning"
          title="本次充值结果尚未确认，已阻止重复提交"
          description={
            <>
              <p>
                用户：{uncertain.user.username}（UID {uncertain.body.userId}），金额：
                {uncertain.body.amount} 冠军币。
              </p>
              <p>
                {mutation.error?.message}
                。请先通过用户到账通知或原系统流水核实是否到账；本页面不会自动重试。
              </p>
            </>
          }
          action={
            <Button
              onClick={() => {
                setUncertain(null);
                setTarget(null);
                setDraft(null);
                form.resetFields();
                setSearch('');
                setKeyword('');
                mutation.reset();
              }}
            >
              已核实，重新填写
            </Button>
          }
        />
      )}
      <Row gutter={[24, 24]}>
        <Col xs={24} xl={15}>
          <Card className="content-card" title="充值信息">
            <div className="recharge-form">
              <label htmlFor="recharge-search">搜索用户</label>
              <Input
                id="recharge-search"
                aria-label="搜索充值用户"
                value={search}
                allowClear
                disabled={locked || draft !== null}
                placeholder="输入账号、游戏 ID 或 KOOK 昵称"
                style={{ marginTop: 10, marginBottom: 16 }}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setTarget(null);
                }}
              />
              <QueryError error={keyword ? users.error : null} retry={users.refetch} />
              <Select
                aria-label="充值用户"
                virtual={false}
                placeholder={
                  keyword && !users.isFetching ? '请选择搜索到的用户' : '输入关键字搜索后选择用户'
                }
                style={{ width: '100%' }}
                value={target?.id}
                disabled={
                  locked || draft !== null || !keyword || keyword !== search.trim() || users.isError
                }
                loading={users.isFetching || keyword !== search.trim()}
                notFoundContent={users.isFetching ? '搜索中…' : '未找到匹配用户'}
                onChange={(value) =>
                  setTarget(users.data?.users.find((user) => user.id === value) || null)
                }
                options={(users.data?.users || []).map((user) => ({
                  value: user.id,
                  label: `${user.username}${user.profile?.gameName ? ` · ${user.profile.gameName}` : ''} · UID ${user.id}`,
                }))}
              />
              {target && (
                <div className="recharge-user-info">
                  <strong>{target.profile?.gameName || target.username}</strong>
                  <small>
                    账号：{target.username} · UID {target.id}
                  </small>
                  <small>
                    审核状态：
                    {target.status === 'APPROVED'
                      ? '已通过'
                      : target.status === 'PENDING'
                        ? '待审核'
                        : target.status}
                  </small>
                </div>
              )}
              <p className="shop-help" style={{ marginBottom: 24 }}>
                搜索最多返回 20 位匹配用户；当前登录账号遵循原接口规则，不在此列表中。
              </p>
              <Form
                form={form}
                layout="vertical"
                onFinish={prepare}
                disabled={locked || draft !== null}
                initialValues={{ note: '' }}
                requiredMark={false}
              >
                <Form.Item
                  name="amount"
                  label="充值金额（冠军币）"
                  rules={[
                    { required: true, message: '请填写充值金额' },
                    {
                      validator: (_, value) =>
                        value == null || (Number.isInteger(value) && value > 0 && value <= MAX_INT)
                          ? Promise.resolve()
                          : Promise.reject(new Error('充值金额必须是正整数')),
                    },
                  ]}
                >
                  <InputNumber
                    min={1}
                    max={MAX_INT}
                    style={{ width: '100%' }}
                    placeholder="请输入正整数"
                  />
                </Form.Item>
                <Form.Item name="note" label="充值备注">
                  <Input.TextArea
                    rows={3}
                    maxLength={500}
                    showCount
                    placeholder="例如：活动奖励、赛事补偿（可选）"
                  />
                </Form.Item>
                <Button
                  type="primary"
                  aria-label="核对充值信息"
                  htmlType="submit"
                  loading={busy}
                  disabled={locked || !target || draft !== null}
                >
                  核对充值信息
                </Button>
              </Form>
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card className="content-card" title="本次操作结果">
            {receipt ? (
              <>
                <Alert type="success" showIcon title="充值成功" style={{ marginBottom: 20 }} />
                <Descriptions
                  column={1}
                  items={[
                    {
                      key: 'user',
                      label: '用户',
                      children: `${receipt.user.username}（UID ${receipt.result.user_id}）`,
                    },
                    {
                      key: 'amount',
                      label: '充值金额',
                      children: `${receipt.result.amount} 冠军币`,
                    },
                    {
                      key: 'balance',
                      label: '到账后余额',
                      children: `${receipt.result.balance} 冠军币`,
                    },
                    { key: 'note', label: '备注', children: receipt.result.note || '无' },
                  ]}
                />
              </>
            ) : (
              <p className="muted">成功充值后，在这里显示到账金额和业务服务返回的余额。</p>
            )}
          </Card>
        </Col>
      </Row>
      <Modal
        title="确认充值"
        open={draft !== null}
        okText="确认到账"
        cancelText="返回修改"
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
        onCancel={() => {
          if (!busy) {
            setDraft(null);
            mutation.reset();
          }
        }}
        onOk={() => {
          if (draft && !busy && !submitted.current) {
            submitted.current = true;
            mutation.mutate(draft);
          }
        }}
      >
        <Descriptions
          column={1}
          style={{ marginTop: 24 }}
          items={[
            { key: 'user', label: '用户账号', children: draft?.user.username },
            { key: 'id', label: '用户 ID', children: draft?.body.userId },
            { key: 'game', label: '游戏 ID', children: draft?.user.profile?.gameName || '未填写' },
            {
              key: 'amount',
              label: '充值金额',
              children: <strong>{draft?.body.amount} 冠军币</strong>,
            },
            { key: 'note', label: '备注', children: draft?.body.note || '无' },
          ]}
        />
        {mutation.error && (
          <Alert
            showIcon
            type="error"
            title="充值未完成"
            description={mutation.error.message}
            style={{ marginTop: 20 }}
          />
        )}
      </Modal>
    </>
  );
}
