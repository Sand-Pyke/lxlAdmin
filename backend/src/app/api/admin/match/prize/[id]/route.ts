import { adminRoute, requiredId } from '@/server/api';
import { setMatchPrizePool } from '@/server/prize';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ id: string }>(async ({ params, body, adminId }) =>
  setMatchPrizePool(requiredId(params.id), body.prize_pool, adminId),
);
