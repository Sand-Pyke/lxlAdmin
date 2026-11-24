import { App, Form, Input, Modal } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { post } from '../api/client';

type ChangePasswordForm = {
  old_pwd: string;
  new_pwd: string;
  confirm: string;
};

const PASSWORD_PATTERN = /^[\x21-\x7e]{6,64}$/;
const PASSWORD_HINT = '6-64 个字符，仅限字母、数字与英文符号';

export default function ChangePassword({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<ChangePasswordForm>();
  const { message } = App.useApp();
  const mutation = useMutation({
    mutationFn: (values: ChangePasswordForm) =>
      post('/api/user/change_pwd', { old_pwd: values.old_pwd, new_pwd: values.new_pwd }),
    onSuccess: (data) => {
      void message.success(data.msg || '密码修改成功');
      form.resetFields();
      onClose();
    },
    onError: (e) => {
      void message.error(e.message);
    },
  });
  return (
    <Modal
      title="修改密码"
      open={open}
      okText="确认修改"
      cancelText="取消"
      confirmLoading={mutation.isPending}
      onOk={() => form.submit()}
      onCancel={() => {
        if (!mutation.isPending) onClose();
      }}
      cancelButtonProps={{ disabled: mutation.isPending }}
      maskClosable={!mutation.isPending}
      closable={!mutation.isPending}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => mutation.mutate(values)}
        style={{ marginTop: 24 }}
      >
        <Form.Item
          name="old_pwd"
          label="原密码"
          rules={[{ required: true, message: '请输入原密码' }]}
        >
          <Input.Password autoComplete="current-password" placeholder="请输入原密码" />
        </Form.Item>
        <Form.Item
          name="new_pwd"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { pattern: PASSWORD_PATTERN, message: PASSWORD_HINT },
          ]}
        >
          <Input.Password autoComplete="new-password" placeholder={PASSWORD_HINT} />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新密码"
          dependencies={['new_pwd']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('new_pwd') === value) return Promise.resolve();
                return Promise.reject(new Error('两次输入的密码不一致'));
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" placeholder="请再次输入新密码" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
