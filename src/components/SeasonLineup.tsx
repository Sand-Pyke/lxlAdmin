import { useState } from 'react';
import { App, Modal, Select, Space, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { post } from '../api/client';
import type { SeasonMatch, SeasonTeam } from '../api/seasons';
import { positionText } from '../data/draft-options';

export default function SeasonLineup({
  match,
  teams,
  onClose,
  onChanged,
}: {
  match: SeasonMatch;
  teams: SeasonTeam[];
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { message } = App.useApp();
  const [players, setPlayers] = useState<Record<number, number>>(() =>
    Object.fromEntries(
      match.substitutions.map(({ starter_user_id, substitute_user_id }) => [
        starter_user_id,
        substitute_user_id,
      ]),
    ),
  );
  const contenders = teams.filter(
    (team) => team.id === match.team_one_id || team.id === match.team_two_id,
  );
  const save = useMutation({
    mutationFn: () =>
      post('/api/admin/season/match/lineup', {
        matchId: match.id,
        substitutions: contenders.flatMap((team) =>
          team.members
            .filter((member) => member.role !== 'SUB' && players[member.user_id])
            .map((member) => ({
              teamId: team.id,
              starterUserId: member.user_id,
              substituteUserId: players[member.user_id],
            })),
        ),
      }),
    onSuccess: async () => {
      void message.success('本场对阵阵容已更新');
      onClose();
      await onChanged();
    },
    onError: (error) => void message.error(error.message),
  });
  return (
    <Modal
      title="调整本场阵容"
      open
      onCancel={onClose}
      onOk={() => save.mutate()}
      okText="保存阵容"
      confirmLoading={save.isPending}
      closable={!save.isPending}
      cancelButtonProps={{ disabled: save.isPending }}
    >
      <Space orientation="vertical" style={{ width: '100%' }}>
        {contenders.map((team) => (
          <Space orientation="vertical" key={team.id} style={{ width: '100%' }}>
            <Typography.Text strong>{team.name}</Typography.Text>
            {team.members
              .filter((member) => ['CAPTAIN', 'STARTER'].includes(member.role))
              .map((starter) => {
                const selected = players[starter.user_id];
                const options = team.members.filter(
                  (member) =>
                    member.role === 'SUB' &&
                    member.position === starter.position &&
                    (member.user_id === selected ||
                      !Object.values(players).includes(member.user_id)),
                );
                return (
                  <Space key={starter.user_id} wrap>
                    <Typography.Text>
                      {positionText(starter.position)} · {starter.game_name || starter.username}
                    </Typography.Text>
                    <Select
                      aria-label={`替换 ${starter.game_name || starter.username}`}
                      allowClear
                      placeholder="保持首发"
                      style={{ width: 180 }}
                      value={selected}
                      disabled={
                        save.isPending ||
                        (!selected &&
                          (!options.length ||
                            team.members.filter((member) => players[member.user_id]).length >= 2))
                      }
                      options={options.map((member) => ({
                        value: member.user_id,
                        label: member.game_name || member.username,
                      }))}
                      onChange={(value) =>
                        setPlayers((previous) => {
                          const next = { ...previous };
                          if (value) next[starter.user_id] = value;
                          else delete next[starter.user_id];
                          return next;
                        })
                      }
                    />
                  </Space>
                );
              })}
          </Space>
        ))}
      </Space>
    </Modal>
  );
}
