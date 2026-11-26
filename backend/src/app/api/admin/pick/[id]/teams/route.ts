import { adminRoute, badRequest, requiredId, unwrap } from '@/server/api';
import { createDraftTeams } from '@/server/roster';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ id: string }>(async ({ params, body, adminId }) => {
  if (!Array.isArray(body.names) || !body.names.length || body.names.length > 100)
    throw badRequest('请选择有效的战队');
  const names = body.names.map((name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) throw badRequest('队伍名称不能为空');
    return name.trim();
  });
  if (new Set(names.map((name) => name.toUpperCase())).size !== names.length)
    throw badRequest('不能重复选择同一支队伍');
  return unwrap(await createDraftTeams(requiredId(params.id), names, adminId), '队伍已保存');
});
