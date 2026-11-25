import { prisma } from '@/lib/prisma';
import { forbidden, notFound } from '@/server/api';

/**
 * 管理员账号之间的操作边界。
 *
 * 管理员分三级：普通管理员（isAdmin）、二级管理员（isAdmin + isSecondaryAdmin）、
 * 核心管理员（isCoreAdmin）。二级管理员在普通管理员的基础上额外拥有
 * 「重置段位 / 处罚用户 / 取消报名」三项权限，这三项普通管理员一律不可用。
 *
 * 规则：管理员只能管理「普通用户」。除核心管理员外，任何管理员都**不能**审核、删除或
 * 改动其他管理员账号，避免管理员互相打压。管理员权限（设为核心 / 二级 / 普通 / 取消）
 * 只有核心管理员可以调整。
 *
 * 放在独立模块而不是 `server/admin.ts` 里，是为了让 `server/records.ts` 这类
 * 只需要边界校验的模块也能引用，避免 `api.ts` ⇄ `auth.ts` 的循环依赖。
 */

/** 管理员级别：0 普通用户、1 普通管理员、2 二级管理员、3 核心管理员。 */
export type AdminLevel = 0 | 1 | 2 | 3;

/** 读取操作者的管理员级别（isAdmin 是前提，二级/核心都必须同时是管理员）。 */
export async function adminLevelOf(actorId: number): Promise<AdminLevel> {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { isAdmin: true, isSecondaryAdmin: true, isCoreAdmin: true },
  });
  if (!actor?.isAdmin) return 0;
  if (actor.isCoreAdmin) return 3;
  return actor.isSecondaryAdmin ? 2 : 1;
}

/** 当前操作者是否为核心管理员（按 User.isCoreAdmin 判定）。 */
export async function isCoreAdminActor(actorId: number) {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { isCoreAdmin: true },
  });
  return Boolean(actor?.isCoreAdmin);
}

/** 断言操作者至少是二级管理员（二级 / 核心）：重置段位、处罚、取消报名走这里。 */
export async function assertSecondaryAdmin(
  actorId: number,
  message = '只有二级管理员及以上权限可以执行该操作',
) {
  if ((await adminLevelOf(actorId)) < 2) throw forbidden(message);
}

/**
 * 状态限制是否仍然生效：核心管理员返回 false（放行，可绕过赛事状态限制去修正数据），
 * 其他人保持 blocked 原值不变。actorId 为空（非后台调用）时一律不放开。
 */
export async function statusStillBlocked(
  actorId: number | undefined,
  blocked: boolean,
): Promise<boolean> {
  if (!blocked) return false;
  if (actorId == null) return true;
  return !(await isCoreAdminActor(actorId));
}

/**
 * 断言操作者有权管理目标账号：目标是管理员且操作者不是核心管理员时直接 403。
 * 目标不存在时抛 404；合法时返回目标账号的基本信息，调用方无需重复查询。
 */
export async function assertCanManageUser(actorId: number, userId: number) {
  const [actor, target] = await Promise.all([
    prisma.user.findUnique({ where: { id: actorId }, select: { isCoreAdmin: true } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, isAdmin: true, isSecondaryAdmin: true, isCoreAdmin: true },
    }),
  ]);
  if (!actor) throw forbidden('请先登录');
  if (!target) throw notFound('用户不存在');
  if ((target.isAdmin || target.isSecondaryAdmin) && !actor.isCoreAdmin) {
    throw forbidden('不能操作其他管理员账号');
  }
  return target;
}
