const positions = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'];
let state;
export function resetDraft() {
  state = {
    board: {
      match: {
        id: 1,
        name: '验收测试常规赛',
        status: 'CREATED',
        use_fee: true,
        bo: 'BO5',
        captain_position: '',
      },
      teams: [],
      budget: 30,
    },
    signs: Array.from({ length: 10 }, (_, i) => ({
      id: 101 + i,
      user_id: 1001 + i,
      username: `draft-player-${i + 1}`,
      game_name: `选人测试${i + 1}#1234`,
      yy_name: '',
      avatar: '',
      rank: '钻石',
      main_pos: positions[i % 5],
      sub_pos: '',
      is_off_role: false,
      team_id: null,
      team_pos: '',
      fee: 6,
      is_waitlisted: false,
      is_captain: false,
      captain_team_ready: true,
      leaderboard_rank: i + 1,
      kda: 2.5 + i / 10,
      recent: 'W L W W L',
    })),
  };
}
resetDraft();
function sync() {
  for (const team of state.board.teams) {
    const members = state.signs.filter((sign) => sign.team_id === team.id);
    team.player_count = members.length;
    team.used_fee = members.reduce((sum, sign) => sum + sign.fee, 0);
  }
}
function clear() {
  state.signs.forEach((sign) => {
    sign.team_id = null;
    sign.team_pos = '';
  });
  sync();
}
function create(name) {
  const id = Math.max(200, ...state.board.teams.map((team) => team.id)) + 1;
  const order = state.board.teams.length;
  state.board.teams.push({
    id,
    name,
    player_count: 0,
    used_fee: 0,
    draft_order: order,
    sort_order: order,
  });
  return id;
}
export function draftRequest(req, res, url, body, matches = []) {
  const path = url.pathname;
  const send = (data, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
    return true;
  };
  if (path === '/api/__test/draft-budget') {
    state.board.budget = 1;
    return send({ ok: true });
  }
  if (path === '/api/__test/draft-second-round') {
    const ids = [create('DK'), create('T1')];
    for (const [index, id] of ids.entries()) {
      for (let pick = 0; pick < 2; pick++) {
        const sign = state.signs[index * 5 + pick];
        sign.team_id = id;
        sign.team_pos = sign.main_pos;
        sign.is_captain = pick === 0;
      }
    }
    sync();
    return send({ ok: true });
  }
  if (path === '/api/__test/draft-captains') {
    state.board.match.captain_position = 'TOP';
    create('队长一队');
    create('队长二队');
    for (const [i, sign] of [state.signs[0], state.signs[5]].entries()) {
      sign.team_id = state.board.teams[i].id;
      sign.team_pos = 'TOP';
      sign.is_captain = true;
      sign.captain_team_ready = false;
      state.board.teams[i].captain_signup_id = sign.id;
    }
    sync();
    return send({ ok: true });
  }
  if (path === '/api/admin/draft/music')
    return send({ tracks: [{ name: '测试背景音乐', src: '/assets/music/fixture.mp3' }] });
  if (path === '/api/admin/pick/1') {
    sync();
    return send(state);
  }
  if (path === '/api/admin/pick/1/teams' && req.method === 'POST') {
    const teams = body.names.map((name) => {
      const existing = state.board.teams.find((team) => team.name === name);
      if (existing) return existing;
      const id = create(name);
      return state.board.teams.find((team) => team.id === id);
    });
    return send({ teams, teamCount: state.board.teams.length });
  }
  if (path === '/api/admin/teams/1') {
    sync();
    return send({ ...state.board, signs: state.signs, current_round: 1, round_pairs: [] });
  }
  if (/^\/api\/admin\/pick\/\d+$/.test(path)) return send({ error: '赛事不存在' }, 404);
  if (path === '/api/admin/team/create') {
    create(body.name);
    return send({ msg: '队伍已创建' });
  }
  if (path === '/api/admin/team/assign') {
    const sign = state.signs.find((sign) => sign.id === body.signId);
    if (!sign) return send({ error: '报名不存在' }, 404);
    if (body.teamId == null) {
      sign.team_id = null;
      sign.team_pos = '';
      sync();
      return send({ msg: '已退回待选池' });
    }
    const team = state.board.teams.find((team) => team.id === body.teamId);
    if (!team) return send({ error: '队伍不存在' }, 404);
    const members = state.signs.filter((item) => item.team_id === team.id);
    if (members.length >= 5 || members.some((item) => item.team_pos === body.teamPosition))
      return send({ error: '人数已满或位置被占用' }, 409);
    if (
      team.used_fee + sign.fee > state.board.budget &&
      (body.overrideBudget || 0) < team.used_fee + sign.fee
    )
      return send({ error: '队伍预算不足' }, 400);
    sign.team_id = team.id;
    sign.team_pos = body.teamPosition;
    sync();
    return send({
      msg: '分配完成',
      draftPick: body.draftTeamIds && {
        signId: sign.id,
        teamId: team.id,
        teamPosition: sign.team_pos,
        positionOrder: team.player_count,
        isCaptain: team.player_count === 1,
        playerCount: team.player_count,
        usedFee: team.used_fee,
      },
    });
  }
  if (path === '/api/admin/team/auto_assign') {
    if (!body.balancedDraft) clear();
    const teams = body.balancedDraft
      ? state.board.teams.filter((team) => body.draftTeamIds.includes(team.id))
      : state.board.teams;
    for (const sign of state.signs) {
      if (sign.team_id) continue;
      const team = teams.find(
        (team) =>
          state.signs.filter((item) => item.team_id === team.id).length < 5 &&
          !state.signs.some((item) => item.team_id === team.id && item.team_pos === sign.main_pos),
      );
      if (team) {
        sign.team_id = team.id;
        sign.team_pos = sign.main_pos;
      }
    }
    sync();
    return send({ msg: '智能分配完成' });
  }
  if (path === '/api/admin/team/clear_assignments') {
    clear();
    return send({ msg: '清空成功' });
  }
  if (path === '/api/admin/pick/1/discard') {
    clear();
    state.board.teams = [];
    return send({ msg: '草稿已清空' });
  }
  if (path === '/api/admin/team/reorder') {
    body.teamIds.forEach((id, index) => {
      state.board.teams.find((team) => team.id === id).sort_order = index;
    });
    return send({ msg: '顺序已更新' });
  }
  if (/^\/api\/admin\/team\/delete\/\d+$/.test(path)) {
    const id = Number(path.split('/').pop());
    state.signs.forEach((sign) => {
      if (sign.team_id === id) {
        sign.team_id = null;
        sign.team_pos = '';
      }
    });
    state.board.teams = state.board.teams.filter((team) => team.id !== id);
    return send({ msg: '队伍已删除' });
  }
  if (path === '/api/admin/match/finish_pick/1') {
    sync();
    if (state.board.teams.length !== 2 || state.board.teams.some((team) => team.player_count !== 5))
      return send({ error: '请选满队伍' }, 400);
    state.board.match.status = 'LIVE';
    const match = matches.find((match) => match.id === 1);
    if (match) match.status = 'LIVE';
    return send({ msg: '赛事已开赛' });
  }
  return false;
}
export function fixtureAudio() {
  const dataSize = 8820;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
