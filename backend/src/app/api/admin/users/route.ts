import { adminRoute } from '@/server/api';

import { adminUserList } from '@/server/admin';

export const dynamic = 'force-dynamic';

// 当前登录的管理员自己不列进用户管理列表；page/pageSize/keyword/status 下推分页与筛选。
export const GET = adminRoute(({ adminId, query }) => adminUserList(adminId, query));
