import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RANKS, normalizeRank, rankIcon } from '../src/data/draft-options.ts';
import { USER_RANKS, userActionRequest } from '../src/api/user-actions.ts';

test('Diamond+ is accepted by rank editing and appears between Master and Diamond', () => {
  assert.deepEqual(USER_RANKS, RANKS);
  assert.equal(RANKS[RANKS.indexOf('大师') + 1], '钻石+');
  assert.equal(RANKS[RANKS.indexOf('钻石+') + 1], '钻石');
  assert.equal(normalizeRank(' 钻石+ '), '钻石+');
  assert.equal(rankIcon('钻石+'), '/assets/rank/Diamond.png');
  assert.deepEqual(userActionRequest('rank', { id: 8 }, { rank: '钻石+' }).body, {
    userId: 8,
    rank: '钻石+',
  });
});
