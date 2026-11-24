import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMarketBody,
  reopenMarketBody,
  pairingKey,
  recentMarketDates,
} from '../src/api/markets.ts';

test('opening a regular market requires the correct fixture and only sends valid game numbers', () => {
  const one = { roundNo: 1, teamOneId: 101, teamTwoId: 102, label: 'A vs B' };
  const two = { roundNo: 1, teamOneId: 103, teamTwoId: 104, label: 'C vs D' };
  const match = { id: 8, bo: 'BO3', pairings: [one, two] };
  assert.throws(() => openMarketBody('REGULAR', match, undefined, 0), /请选择要开盘的对阵/);
  assert.throws(
    () => openMarketBody('REGULAR', { ...match, pairings: [] }, undefined, 0),
    /尚未确定对阵/,
  );
  assert.deepEqual(openMarketBody('REGULAR', match, pairingKey(two), 2), {
    matchId: 8,
    teamOneId: 103,
    teamTwoId: 104,
    roundNo: 2,
  });
  assert.deepEqual(openMarketBody('REGULAR', { ...match, pairings: [one] }, undefined, 0), {
    matchId: 8,
    teamOneId: 101,
    teamTwoId: 102,
  });
  assert.throws(() => openMarketBody('REGULAR', match, pairingKey(one), 4), /不支持/);
  assert.throws(
    () => openMarketBody('REGULAR', { ...match, bo: '六队模式' }, pairingKey(one), 1),
    /不支持/,
  );
});

test('season sources and reopened game markets preserve their own identity', () => {
  assert.deepEqual(openMarketBody('SEASON', { id: 8 }, undefined, 0), { seasonMatchId: 8 });
  assert.throws(() => openMarketBody('SEASON', { id: 8 }, undefined, 1), /不支持分小场/);
  const market = {
    status: 'CLOSED',
    matchId: 8,
    seasonMatchId: null,
    teamOneId: 101,
    teamTwoId: 102,
    roundNo: 2,
  };
  assert.deepEqual(reopenMarketBody(market), {
    matchId: 8,
    teamOneId: 101,
    teamTwoId: 102,
    roundNo: 2,
  });
  assert.deepEqual(reopenMarketBody({ status: 'CLOSED', matchId: null, seasonMatchId: 8 }), {
    seasonMatchId: 8,
  });
  assert.throws(() => reopenMarketBody({ ...market, status: 'SETTLED' }), /不能重新开盘/);
  assert.throws(() => reopenMarketBody({ ...market, status: 'VOID' }), /不能重新开盘/);
});

test('recent date range uses Beijing calendar dates across UTC midnight', () => {
  assert.deepEqual(recentMarketDates(new Date('2026-11-25T16:30:00Z')), [
    '2026-11-25',
    '2026-11-26',
  ]);
});
