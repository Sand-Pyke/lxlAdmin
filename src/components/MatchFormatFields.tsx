import { Form, Input, Select, Switch } from 'antd';
import type { FormInstance } from 'antd';
import {
  BO_OPTIONS,
  CUSTOM_FORMAT,
  CUSTOM_TEAM_COUNTS,
  matchFormatLabel,
  ROUND_FORMATS,
} from '../api/matches';
import { USER_RANKS } from '../api/user-actions';

export type MatchFormatValues = {
  bo: string;
  custom_team_count?: number;
  round_formats?: string[];
  min_signup_rank?: string;
  allow_item_cards?: boolean;
  signup_password?: string;
};

export const defaultCustomFormat = {
  custom_team_count: 4,
  round_formats: ['BO3', 'BO3'],
  min_signup_rank: '',
  allow_item_cards: true,
};

export function MatchFormatFields({
  form,
  legacyFormat,
  allowCustom = true,
  showSignupPassword = false,
}: {
  form: FormInstance;
  legacyFormat?: string;
  allowCustom?: boolean;
  showSignupPassword?: boolean;
}) {
  const bo = Form.useWatch('bo', form);
  const teamCount = Form.useWatch('custom_team_count', form) ?? 4;
  const roundCount = teamCount === 4 ? 2 : 3;
  return (
    <>
      <Form.Item name="bo" label="赛制" rules={[{ required: true }]}>
        <Select
          virtual={false}
          options={[
            ...(legacyFormat
              ? [
                  {
                    value: legacyFormat,
                    label: matchFormatLabel(legacyFormat) + '（历史赛制）',
                    disabled: true,
                  },
                ]
              : []),
            ...BO_OPTIONS.filter((value) => allowCustom || value !== CUSTOM_FORMAT).map(
              (value) => ({ value, label: matchFormatLabel(value) }),
            ),
          ]}
        />
      </Form.Item>
      {bo === CUSTOM_FORMAT && (
        <>
          <Form.Item name="custom_team_count" label="正式参赛人数" rules={[{ required: true }]}>
            <Select
              virtual={false}
              options={CUSTOM_TEAM_COUNTS.map((value) => ({
                value,
                label: value * 5 + ' 人（' + value + ' 队）',
              }))}
              onChange={(count: number) => {
                const current: string[] = form.getFieldValue('round_formats') ?? [];
                form.setFieldValue(
                  'round_formats',
                  Array.from(
                    { length: count === 4 ? 2 : 3 },
                    (_, index) => current[index] ?? 'BO3',
                  ),
                );
              }}
            />
          </Form.Item>
          {Array.from({ length: roundCount }, (_, index) => (
            <Form.Item
              key={index}
              name={['round_formats', index]}
              label={'第 ' + (index + 1) + ' 轮赛制'}
              rules={[{ required: true }]}
            >
              <Select
                virtual={false}
                options={ROUND_FORMATS.map((value) => ({ value, label: value }))}
              />
            </Form.Item>
          ))}
          <Form.Item name="allow_item_cards" label="允许使用道具卡" valuePropName="checked">
            <Switch />
          </Form.Item>
          {showSignupPassword && (
            <Form.Item name="signup_password" label="报名密码" preserve={false}>
              <Input.Password placeholder="选填，留空为公开报名" autoComplete="new-password" />
            </Form.Item>
          )}
          <Form.Item name="min_signup_rank" label="最低报名段位">
            <Select
              virtual={false}
              options={[
                { value: '', label: '不限段位' },
                ...USER_RANKS.filter((rank) => rank && rank !== '未定段').map((value) => ({
                  value,
                  label: value + '及以上',
                })),
              ]}
            />
          </Form.Item>
        </>
      )}
    </>
  );
}
