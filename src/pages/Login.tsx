import { App, Alert, Button, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { login, sessionKey } from '../auth';

export default function Login() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = App.useApp();
  const mutation = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      login(username, password),
    onSuccess: async (viewer) => {
      await client.cancelQueries();
      client.clear();
      client.setQueryData(sessionKey, viewer);
      const from = location.state?.from;
      navigate(
        typeof from === 'string' &&
          from.startsWith('/') &&
          !from.startsWith('//') &&
          !from.startsWith('/login')
          ? from
          : '/',
        { replace: true },
      );
      void message.success('登录成功');
    },
  });
  return (
    <main className="login-page">
      <section className="login-story">
        <a className="brand" href="/">
          <span className="brand-symbol">L</span>
          <span>
            LXL <small>LEAGUE ADMIN</small>
          </span>
        </a>
        <div className="login-story-copy">
          <span className="eyebrow">峡谷冠军联赛 · 运营中心</span>
          <h1>
            每一场精彩，
            <br />
            从这里开始。
          </h1>
          <p>
            让赛事有序进行，让热爱持续发生。
            <br />
            你的联赛管理工作台。
          </p>
          <div className="court-art" aria-hidden="true">
            <div />
            <div />
            <span>LXL</span>
          </div>
        </div>
        <span className="login-footnote">LXL LEAGUE / MANAGEMENT PLATFORM</span>
      </section>
      <section className="login-form-area">
        <div className="login-form">
          <span className="eyebrow">WELCOME BACK</span>
          <Typography.Title level={2}>登录管理平台</Typography.Title>
          <p className="muted">使用已有的联赛管理员账号登录</p>
          {mutation.error && (
            <Alert
              type="error"
              showIcon
              title={mutation.error.message}
              style={{ marginBottom: 24 }}
            />
          )}
          <Form
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => mutation.mutate(values)}
          >
            <Form.Item
              label="管理员账号"
              name="username"
              rules={[{ required: true, whitespace: true, message: '请输入账号' }]}
            >
              <Input
                autoComplete="username"
                prefix={<UserOutlined />}
                placeholder="请输入管理员账号"
                size="large"
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                autoComplete="current-password"
                prefix={<LockOutlined />}
                placeholder="请输入密码"
                size="large"
              />
            </Form.Item>
            <Button
              size="large"
              block
              type="primary"
              htmlType="submit"
              loading={mutation.isPending}
            >
              登录
            </Button>
          </Form>
          <div className="login-note">
            <SafetyCertificateOutlined />
            <span>仅限已授权的管理员访问</span>
          </div>
        </div>
      </section>
    </main>
  );
}
