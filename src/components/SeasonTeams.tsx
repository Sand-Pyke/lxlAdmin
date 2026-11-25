import { useState } from 'react';
import {
  App,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Upload,
} from 'antd';
import { useMutation } from '@tanstack/react-query';
import { post, request } from '../api/client';
import { DIVISION_LABEL, type SeasonBoard, type SeasonTeam } from '../api/seasons';
import { POSITION_OPTIONS, positionText } from '../data/draft-options';

const positionOptions = POSITION_OPTIONS.map((value) => ({ value, label: positionText(value) }));
const roleOptions = [
  { value: 'CAPTAIN', label: '队长' },
  { value: 'STARTER', label: '首发' },
  { value: 'SUB', label: '替补' },
];
const memberName = (member: { game_name: string; username: string }) =>
  member.game_name || member.username;

type Editor = { kind: 'team'; team?: SeasonTeam } | { kind: 'member'; team: SeasonTeam };
type TeamFields = { name: string; abbr?: string; logo?: string };
type MemberFields = { userId: number; role: string; position?: string };

export default function SeasonTeams({
  board,
  core,
  onChanged,
}: {
  board: SeasonBoard;
  core: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { message } = App.useApp();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [teamForm] = Form.useForm<TeamFields>();
  const [memberForm] = Form.useForm<MemberFields>();
  const seasonId = board.season.id;
  const drafting = core && board.season.status === 'DRAFTING';
  const canEditMembers = core && !['SIGNUPS', 'FINISHED'].includes(board.season.status);
  const assigned = new Set(
    board.teams.flatMap((team) => team.members.map((member) => member.user_id)),
  );
  const pool = board.pool.filter((member) => !assigned.has(member.user_id));
  const change = useMutation({
    mutationFn: ({ action, body }: { action: string; body: Record<string, unknown> }) =>
      post(`/api/admin/season/${action}`, { seasonId, ...body }),
    onSuccess: async ({ msg }) => {
      void message.success(msg || '战队名单已更新');
      setEditor(null);
      await onChanged();
    },
    onError: (error) => void message.error(error.message),
  });
  const upload = useMutation({
    mutationFn: (logo: File) => {
      const body = new FormData();
      body.append('logo', logo);
      return request<{ url: string }>('/api/admin/team/logo/upload', { method: 'POST', body });
    },
    onSuccess: ({ url }) => teamForm.setFieldValue('logo', url),
    onError: (error) => void message.error(error.message),
  });
  const busy = change.isPending || upload.isPending;
  function openTeam(team?: SeasonTeam) {
    teamForm.resetFields();
    teamForm.setFieldsValue({
      name: team?.name || '',
      abbr: team?.abbr || '',
      logo: team?.logo || '',
    });
    setEditor({ kind: 'team', team });
  }
  function openMember(team: SeasonTeam) {
    memberForm.resetFields();
    memberForm.setFieldValue(
      'role',
      team.members.some((member) => member.role === 'CAPTAIN') ? 'STARTER' : 'CAPTAIN',
    );
    setEditor({ kind: 'member', team });
  }
  const logo = Form.useWatch('logo', teamForm);
  const role = Form.useWatch('role', memberForm);
  return (
    <Card
      className="content-card"
      title="战队名单"
      extra={drafting && <Button onClick={() => openTeam()}>新建战队</Button>}
    >
      <Table
        rowKey="id"
        dataSource={board.teams}
        pagination={false}
        scroll={{ x: 700 }}
        columns={[
          {
            title: '战队',
            render: (_, team) => (
              <Space>
                <Avatar shape="square" src={team.logo || undefined}>
                  {team.abbr || team.name[0]}
                </Avatar>
                {team.name}
              </Space>
            ),
          },
          {
            title: '分组',
            render: (_, team) =>
              drafting ? (
                <Select
                  value={team.division || undefined}
                  placeholder="未分组"
                  disabled={busy}
                  style={{ width: 110 }}
                  options={Object.entries(DIVISION_LABEL).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(division) =>
                    change.mutate({ action: 'team/group', body: { teamId: team.id, division } })
                  }
                />
              ) : (
                DIVISION_LABEL[team.division] || '未分组'
              ),
          },
          { title: '队员', render: (_, team) => team.members.length },
          {
            title: '操作',
            render: (_, team) => (
              <Space wrap>
                {canEditMembers && (
                  <Button size="small" onClick={() => openMember(team)} disabled={busy}>
                    添加队员
                  </Button>
                )}
                {drafting && (
                  <>
                    <Button size="small" onClick={() => openTeam(team)} disabled={busy}>
                      编辑
                    </Button>
                    <Popconfirm
                      title={`删除「${team.name}」？`}
                      description="队员将从该队名单移除，赛季报名仍保留。"
                      onConfirm={() =>
                        change
                          .mutateAsync({ action: 'team/delete', body: { teamId: team.id } })
                          .catch(() => undefined)
                      }
                    >
                      <Button size="small" danger disabled={busy}>
                        删除战队
                      </Button>
                    </Popconfirm>
                  </>
                )}
              </Space>
            ),
          },
        ]}
        expandable={{
          rowExpandable: (team) => team.members.length > 0,
          expandedRowRender: (team) => (
            <Table
              rowKey="id"
              dataSource={team.members}
              pagination={false}
              size="small"
              columns={[
                { title: '选手', render: (_, member) => memberName(member) },
                {
                  title: '身份',
                  render: (_, member) =>
                    roleOptions.find((item) => item.value === member.role)?.label ?? member.role,
                },
                { title: '分路', render: (_, member) => positionText(member.position) },
                ...(canEditMembers
                  ? [
                      {
                        title: '操作',
                        render: (_: unknown, member: SeasonTeam['members'][number]) => (
                          <Popconfirm
                            title={`移除 ${memberName(member)}？`}
                            onConfirm={() =>
                              change
                                .mutateAsync({
                                  action: 'member/remove',
                                  body: { userId: member.user_id },
                                })
                                .catch(() => undefined)
                            }
                          >
                            <Button type="link" danger disabled={busy}>
                              移除
                            </Button>
                          </Popconfirm>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          ),
        }}
      />
      <Modal
        title={editor?.kind === 'team' && editor.team ? '编辑战队' : '新建战队'}
        open={editor?.kind === 'team'}
        onCancel={() => setEditor(null)}
        onOk={() => teamForm.submit()}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
      >
        <Form
          form={teamForm}
          layout="vertical"
          onFinish={(values) => {
            if (editor?.kind !== 'team') return;
            change.mutate({
              action: editor.team ? 'team/update' : 'team/create',
              body: { ...values, teamId: editor.team?.id },
            });
          }}
        >
          <Form.Item label="队名" name="name" rules={[{ required: true, whitespace: true }]}>
            <Input maxLength={40} />
          </Form.Item>
          <Form.Item label="简称" name="abbr">
            <Input maxLength={16} />
          </Form.Item>
          <Form.Item name="logo" hidden>
            <Input />
          </Form.Item>
          <Space>
            <Avatar shape="square" src={logo || undefined} />
            <Upload
              accept="image/*"
              showUploadList={false}
              beforeUpload={(file) => {
                upload.mutate(file);
                return false;
              }}
            >
              <Button loading={upload.isPending}>上传队标</Button>
            </Upload>
            {logo && (
              <Button onClick={() => teamForm.setFieldValue('logo', '')} disabled={busy}>
                移除队标
              </Button>
            )}
          </Space>
        </Form>
      </Modal>
      <Modal
        title={editor?.kind === 'member' ? `添加队员 · ${editor.team.name}` : '添加队员'}
        open={editor?.kind === 'member'}
        onCancel={() => setEditor(null)}
        onOk={() => memberForm.submit()}
        confirmLoading={busy}
        closable={!busy}
        cancelButtonProps={{ disabled: busy }}
      >
        <Form
          form={memberForm}
          layout="vertical"
          onFinish={(values) => {
            if (editor?.kind !== 'member') return;
            change.mutate({ action: 'member/assign', body: { ...values, teamId: editor.team.id } });
          }}
        >
          <Form.Item label="选手" name="userId" rules={[{ required: true }]}>
            <Select
              showSearch={{ optionFilterProp: 'label' }}
              options={pool.map((member) => ({
                value: member.user_id,
                label: `${memberName(member)}（${member.rank || '未定段'}）`,
              }))}
            />
          </Form.Item>
          <Form.Item label="身份" name="role" rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          <Form.Item label="分路" name="position" rules={[{ required: role === 'STARTER' }]}>
            <Select allowClear options={positionOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
