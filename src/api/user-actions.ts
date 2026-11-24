import type { User } from './types';
import type { Permission } from '../permissions/access.ts';
export type UserAction = 'role' | 'rank' | 'ban' | 'unban' | 'password' | 'delete' | 'gameName';
export const USER_ACTIONS: Record<UserAction, { label: string; permission: Permission }> = {
  role: { label: '设置角色', permission: 'users.role.assign' },
  rank: { label: '重置段位', permission: 'users.rank.update' },
  ban: { label: '处罚用户', permission: 'users.ban' },
  unban: { label: '解除处罚', permission: 'users.unban' },
  password: { label: '重置密码', permission: 'users.password.reset' },
  delete: { label: '删除用户', permission: 'users.delete' },
  gameName: { label: '修改游戏 ID', permission: 'users.game_name.update' },
};
export const USER_ROLES = [
  { value: 'USER', label: '普通用户（取消管理员）' },
  { value: 'ADMIN', label: '普通管理员' },
  { value: 'SECONDARY_ADMIN', label: '二级管理员' },
  { value: 'CORE_ADMIN', label: '核心管理员' },
];
export const USER_RANKS = [
  '王者',
  '宗师',
  '大师+',
  '大师',
  '钻石',
  '翡翠',
  '铂金',
  '黄金',
  '白银',
  '青铜',
  '黑铁',
  '未定段',
  '',
];
export type UserActionValues = {
  role?: string;
  rank?: string;
  days?: number;
  gameName?: string;
  confirmation?: string;
};
export function userRole(user: User) {
  return user.isCoreAdmin
    ? 'CORE_ADMIN'
    : user.isSecondaryAdmin
      ? 'SECONDARY_ADMIN'
      : user.isAdmin
        ? 'ADMIN'
        : 'USER';
}
export function userActionRequest(action: UserAction, target: User, values: UserActionValues) {
  const body: Record<string, unknown> = { userId: target.id };
  let path = `/api/admin/users/${{ role: 'admin', rank: 'rank', ban: 'ban', unban: 'unban', password: 'password', gameName: 'game_name', delete: 'delete' }[action]}`;
  if (action === 'role') {
    if (!USER_ROLES.some((role) => role.value === values.role)) throw new Error('请选择有效角色');
    body.role = values.role;
  }
  if (action === 'rank') {
    if (values.rank === undefined || !USER_RANKS.includes(values.rank))
      throw new Error('请选择有效段位');
    body.rank = values.rank;
  }
  if (action === 'ban') {
    if (!Number.isInteger(values.days) || values.days! < 1 || values.days! > 3650)
      throw new Error('处罚天数需为 1–3650 的整数');
    body.days = values.days;
  }
  if (action === 'gameName') {
    const name = values.gameName?.trim() || '';
    if (name && !/^[\u4e00-\u9fa5\u3400-\u4dbfA-Za-z0-9]{1,16}#\d{3,6}$/.test(name))
      throw new Error('游戏 ID 应为名称#数字编号，名称 1–16 位中文/英文/数字，编号 3–6 位数字');
    body.gameName = name;
  }
  if (action === 'delete') {
    if (values.confirmation !== target.username) throw new Error('请输入完整用户账号以确认删除');
    path += `/${target.id}`;
  }
  return { path, body };
}
