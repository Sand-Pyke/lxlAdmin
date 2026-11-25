import { coreAdminRoute, badRequest } from '@/server/api';
import { listAdminMarkets, listOpenableMatches } from '@/server/betting';
import { parseMarketListQuery } from '@/lib/market-list-query';

export const dynamic = 'force-dynamic';

export const GET = coreAdminRoute(async ({ query }) => {
  let filters;
  try {
    filters = parseMarketListQuery(query);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : '筛选条件无效');
  }
  const [result, sources] = await Promise.all([listAdminMarkets(filters), listOpenableMatches()]);
  return { ...result, ...sources };
});
