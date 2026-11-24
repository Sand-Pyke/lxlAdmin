import { Alert, App, Descriptions, Form, Input, InputNumber, Modal, Select } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '../api/client';
import {
  userActionRequest,
  USER_ACTIONS,
  USER_ROLES,
  USER_RANKS,
  userRole,
} from '../api/user-actions';
import type { UserAction, UserActionValues } from '../api/user-actions';
import type { User } from '../api/types';
import { useViewer, sessionKey } from '../auth';
import { can } from '../permissions/access';

export default function UserActionDialog({
  action,
  target,
  onClose,
}: {
  action: UserAction;
  target: User;
  onClose: () => void;
}) {
  const [form] = Form.useForm<UserActionValues>();
  const viewer = useViewer();
  const client = useQueryClient();
  const { message } = App.useApp();
  const allowed = can(viewer, USER_ACTIONS[action].permission, target);
  const mutation = useMutation({
    mutationFn: (values: UserActionValues) => {
      if (!can(viewer, USER_ACTIONS[action].permission, target))
        throw new Error('权限已变更，请刷新页面后重试');
      const request = userActionRequest(action, target, values);
      return post(request.path, request.body);
    },
    onSuccess: async (result) => {
      void message.success(result.msg || '操作已完成');
      onClose();
      await Promise.all([
        client.invalidateQueries({ queryKey: ['users'] }),
        client.invalidateQueries({ queryKey: ['recharge-users'] }),
        client.invalidateQueries({ queryKey: sessionKey }),
      ]);
    },
  });
  return (
    <Modal
      open
      title={USER_ACTIONS[action].label}
      okText={action === 'delete' ? '确认删除用户' : '确认执行'}
      cancelText="取消"
      onOk={() => form.submit()}
      onCancel={() => {
        if (!mutation.isPending) onClose();
      }}
      confirmLoading={mutation.isPending}
      closable={!mutation.isPending}
      maskClosable={!mutation.isPending}
      cancelButtonProps={{ disabled: mutation.isPending }}
      okButtonProps={{ disabled: !allowed, danger: ['delete', 'ban', 'password'].includes(action) }}
    >
      <Descriptions
        style={{ margin: '24px 0' }}
        column={1}
        size="small"
        items={[
          { key: 'user', label: '用户账号', children: target.username },
          { key: 'id', label: 'UID', children: target.id },
          { key: 'game', label: '游戏 ID', children: target.profile?.gameName || '未填写' },
        ]}
      />
      {!allowed && (
        <Alert
          type="warning"
          showIcon
          title="当前账号无权执行此操作"
          style={{ marginBottom: 20 }}
        />
      )}
      {mutation.error && (
        <Alert
          type="error"
          showIcon
          title="操作未完成"
          description={mutation.error.message}
          style={{ marginBottom: 20 }}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        disabled={mutation.isPending || !allowed}
        initialValues={{
          role: userRole(target),
          rank: target.profile?.rank || '',
          days: 7,
          gameName: target.profile?.gameName || '',
        }}
        onFinish={(values) => mutation.mutate(values)}
        requiredMark={false}
      >
        {action === 'role' && (
          <>
            <Alert
              type="info"
              showIcon
              title="调整后按新角色生效；核心管理员拥有后台全部权限。"
              style={{ marginBottom: 20 }}
            />
            <Form.Item
              name="role"
              label="目标角色"
              rules={[{ required: true, message: '请选择角色' }]}
            >
              <Select virtual={false} options={USER_ROLES} />
            </Form.Item>
          </>
        )}
        {action === 'rank' && (
          <>
            <p>更新用户段位并同步历史报名快照，同时清除待审核段位申请。</p>
            <Form.Item name="rank" label="目标段位">
              <Select
                virtual={false}
                options={USER_RANKS.map((value) => ({ value, label: value || '未设置（清空）' }))}
              />
            </Form.Item>
          </>
        )}
        {action === 'ban' && (
          <>
            <Alert
              type="warning"
              showIcon
              title="处罚限制赛事报名，不会删除账号。"
              description="从当前时间起计算处罚；已报名未结束赛事的用户，需先处理报名，服务端会再次检查。"
              style={{ marginBottom: 20 }}
            />
            <Form.Item
              name="days"
              label="处罚天数"
              rules={[{ required: true, message: '请填写处罚天数' }]}
            >
              <InputNumber min={1} max={3650} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}
        {action === 'unban' && (
          <p>确认解除该用户的处罚，恢复其报名资格？其他报名条件仍按赛事规则检查。</p>
        )}
        {action === 'password' && (
          <Alert
            type="warning"
            showIcon
            title="确认重置用户密码？"
            description="密码将重置为现有业务服务的初始密码，执行成功后显示服务端返回的结果。"
          />
        )}
        {action === 'delete' && (
          <>
            <Alert
              type="error"
              showIcon
              title="删除用户无法通过本页面恢复"
              description="现有服务会清理报名并同步赛事人数，再删除账号；资料、战绩等关联数据可能随外键级联删除。"
              style={{ marginBottom: 20 }}
            />
            <Form.Item
              name="confirmation"
              label="输入用户账号确认删除"
              rules={[
                { required: true, message: '请输入完整用户账号' },
                {
                  validator: (_, value) =>
                    value === target.username
                      ? Promise.resolve()
                      : Promise.reject(new Error('输入的账号不一致')),
                },
              ]}
            >
              <Input autoComplete="off" placeholder={target.username} />
            </Form.Item>
          </>
        )}
        {action === 'gameName' && (
          <Form.Item
            name="gameName"
            label="新的游戏 ID"
            extra="名称#数字编号；留空可清除。名称 1–16 位中文/英文/数字，编号 3–6 位数字。"
          >
            <Input />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
