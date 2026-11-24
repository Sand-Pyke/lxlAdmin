'use client';

import {
  ArrowLeftOutlined,
  CheckOutlined,
  ClearOutlined,
  LogoutOutlined,
  SaveOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Empty, InputNumber, Modal, Spin, Space } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useBlocker } from 'react-router-dom';
import { useViewer } from '../../auth';
import { can } from '../../permissions/access';
import { RankLabel } from './rank-label';
import { RecentForm } from './recent-results';
import {
  EIGHT_TEAM_FORMAT,
  EIGHT_TEAM_FORMAT_V2,
  POSITION_OPTIONS,
  RANKS,
  SIX_TEAM_FORMAT,
  SIX_TEAM_FORMAT_V2,
  positionText,
} from '../../data/draft-options';
import { LEAGUE_LABEL, TEAMS_BY_LEAGUE, teamLogo } from '../../data/draft-teams';
import { errorText, getJson, postJson as rawPostJson } from './api-client';
import { App } from 'antd';
import { DraftMusicPlayer, type DraftMusicTrack } from './draft-music-player';
import { pollLiveJson } from './live-poll';

export type Sign = {
  id: number;
  user_id: number;
  username: string;
  yy_name: string;
  game_name: string;
  avatar: string;
  rank: string;
  main_pos: string;
  sub_pos: string;
  is_off_role: boolean;
  team_id: number | null;
  team_pos: string;
  fee: number;
  fee_card_active?: boolean;
  fee_card_used?: boolean;
  draft_rank?: string;
  draft_fee?: number;
  can_substitute?: boolean;
  is_waitlisted?: boolean;
  is_captain?: boolean;
  captain_team_ready?: boolean;
  pos_order?: number;
  leaderboard_rank: number | null;
  kda: number;
  recent?: string;
};

export type Team = {
  logo?: string;
  captain_signup_id?: number | null;
  id: number;
  name: string;
  sort_order: number;
  draft_order: number;
  player_count: number;
  used_fee: number;
};

export type Board = {
  match: {
    id: number;
    name: string;
    status: string;
    use_fee: boolean;
    bo: string;
    captain_position?: string;
  };
  teams: Team[];
  budget: number;
};

export type DraftData = { board: Board; signs: Sign[] };

const POSITIONS = POSITION_OPTIONS.map((position) => ({
  value: position,
  label: positionText(position),
}));
const FLEX_POSITION = 'FLEX';
const WAITLIST_CATEGORY = 'WAITLIST';
const PICK_CATEGORIES = [
  ...POSITIONS,
  { value: WAITLIST_CATEGORY, label: '候补' },
  { value: FLEX_POSITION, label: '补位' },
];
const RANK_FILTER_VALUES = RANKS.filter((rank) => rank !== '' && rank !== '未定段');
const PRESET_TEAMS = TEAMS_BY_LEAGUE.flatMap(({ teams }) => teams);
const PRESET_TEAM_KEYS = new Set(PRESET_TEAMS.map((team) => teamKey(team.name)));

function teamKey(name: string) {
  const key = name.trim().toLocaleUpperCase();
  return key;
}

function presetName(name: string) {
  return PRESET_TEAMS.find((team) => teamKey(team.name) === teamKey(name))?.name ?? name;
}

/** 各赛制在队伍选择阶段允许的队伍数量；BO1 不限制（返回 null）。 */
function maxTeamsFor(bo: string): number | null {
  if (bo === 'BO5') return 2;
  if (bo === 'BO3') return 4;
  if (bo === SIX_TEAM_FORMAT || bo === SIX_TEAM_FORMAT_V2) return 6;
  if (bo === EIGHT_TEAM_FORMAT || bo === EIGHT_TEAM_FORMAT_V2) return 8;
  return null;
}

function teamLimitHint(bo: string): string {
  if (bo === 'BO5') return '当前赛事为两队 BO5，不能选择多余的战队';
  if (bo === 'BO3') return '当前赛事为四队 BO3，不能选择多余的战队';
  if (bo === SIX_TEAM_FORMAT) return '当前赛事为六队模式，不能选择多余的战队';
  if (bo === SIX_TEAM_FORMAT_V2) return '当前赛事为六队模式2.0，不能选择多余的战队';
  if (bo === EIGHT_TEAM_FORMAT) return '当前赛事为八队模式，不能选择多余的战队';
  if (bo === EIGHT_TEAM_FORMAT_V2) return '当前赛事为八队模式2.0，不能选择多余的战队';
  return '不能选择更多战队';
}

function candidateCompare(a: Sign, b: Sign) {
  const aRank = a.leaderboard_rank && a.leaderboard_rank <= 10 ? a.leaderboard_rank : null;
  const bRank = b.leaderboard_rank && b.leaderboard_rank <= 10 ? b.leaderboard_rank : null;
  if (aRank && bRank) return aRank - bRank;
  if (aRank) return -1;
  if (bRank) return 1;
  return b.kda - a.kda || a.user_id - b.user_id;
}

export function BigScreenDraft({
  matchId,
  musicTracks,
}: {
  matchId: string;
  musicTracks: DraftMusicTrack[];
}) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const viewer = useViewer();
  const postJson = (url: string, body?: unknown) => {
    if (!can(viewer, 'draft.control')) throw new Error('当前账号没有选人操作权限');
    if (
      (url.endsWith('/discard') || url.endsWith('/clear_assignments')) &&
      !can(viewer, 'draft.reset')
    )
      throw new Error('当前账号没有清空选人的权限');
    return rawPostJson(url, body);
  };
  const [data, setData] = useState<DraftData | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingTeams, setSavingTeams] = useState(false);
  const [smartAssigning, setSmartAssigning] = useState(false);
  const [clearingAssignments, setClearingAssignments] = useState(false);
  const [busySign, setBusySign] = useState<number | null>(null);
  const [reorderingTeams, setReorderingTeams] = useState(false);
  const [battleOrderVisible, setBattleOrderVisible] = useState(false);
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);
  const [targetTeamId, setTargetTeamId] = useState<number | null>(null);
  const [stage, setStage] = useState<'teams' | 'workspace'>('teams');
  const [position, setPosition] = useState('TOP');
  const [rankFilter, setRankFilter] = useState<string>('all');
  const [budgetBlock, setBudgetBlock] = useState<{ sign: Sign; minimum: number } | null>(null);
  const [overrideBudget, setOverrideBudget] = useState(0);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);
  const [exitBusy, setExitBusy] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<Sign | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const allowHistoryExit = useRef(false);
  const dirtyRef = useRef(false);
  const initializedTeams = useRef(false);

  const reload = useCallback(async (): Promise<DraftData | null> => {
    setLoading(true);
    try {
      const response = await getJson(`/api/admin/pick/${matchId}`);
      const next = response as unknown as DraftData;
      setData(next);
      if (!initializedTeams.current) {
        initializedTeams.current = true;
        setSelectedTeams([...new Set(next.board.teams.map((team) => presetName(team.name)))]);
        if (next.board.teams.length > 0) {
          setTargetTeamId(next.board.teams[0].id);
          if (next.board.teams.every((team) => team.player_count === 0))
            setPosition(next.board.match.captain_position || 'TOP');
          setStage('workspace');
        }
      }
      return next;
    } catch (error) {
      message.error(errorText(error, '大屏选人数据加载失败'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      pollLiveJson<DraftData>(`/api/admin/pick/${matchId}`, (next) => {
        setData(next);
        if (next.board.match.captain_position) {
          setSelectedTeams(
            next.board.teams
              .filter(
                (team) =>
                  team.captain_signup_id || next.signs.some((sign) => sign.team_id === team.id),
              )
              .map((team) => team.name),
          );
        }
      }),
    [matchId],
  );

  const busyRef = useRef(false);
  busyRef.current =
    savingTeams ||
    smartAssigning ||
    clearingAssignments ||
    busySign !== null ||
    reorderingTeams ||
    exitBusy;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowHistoryExit.current &&
      (dirtyRef.current || busyRef.current) &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (busyRef.current) {
      message.info('当前操作完成后再返回');
      blocker.reset();
    } else setExitPromptOpen(true);
  }, [blocker]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!allowHistoryExit.current && (dirtyRef.current || busyRef.current)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  function closeExitPrompt() {
    setExitPromptOpen(false);
    if (blocker.state === 'blocked') blocker.reset();
  }
  function leaveDraft(url: string) {
    allowHistoryExit.current = true;
    dirtyRef.current = false;
    if (blocker.state === 'blocked') blocker.reset();
    navigate(url, { replace: true });
  }

  function requestExit() {
    if (
      busySign !== null ||
      savingTeams ||
      smartAssigning ||
      clearingAssignments ||
      reorderingTeams ||
      exitBusy
    ) {
      message.info('当前操作完成后再返回');
      return;
    }
    // 选人已保存（点过「保存并查看对阵」）且没有新的编辑时，直接返回不再提示。
    if (!dirtyRef.current) {
      allowHistoryExit.current = true;
      leaveDraft('/matches');
      return;
    }
    setExitPromptOpen(true);
  }

  async function exitWithDraft() {
    if (exitBusy) return;
    setExitBusy(true);
    try {
      if (board) {
        // 以当前队伍选择为准：删除未勾选的队伍（其队员录入一并清空），创建新勾选的队伍。
        const selectedKeys = new Set(selectedTeams.map(teamKey));
        for (const team of board.teams) {
          if (selectedKeys.has(teamKey(team.name))) continue;
          await postJson(`/api/admin/team/delete/${team.id}`, {});
        }
        const existingKeys = new Set(board.teams.map((team) => teamKey(team.name)));
        for (const name of selectedTeams) {
          if (existingKeys.has(teamKey(name))) continue;
          await postJson('/api/admin/team/create', { matchId: board.match.id, name });
          existingKeys.add(teamKey(name));
        }
      }
      allowHistoryExit.current = true;
      message.success('选人草稿已保存');
      leaveDraft('/matches');
    } catch (error) {
      message.error(errorText(error, '保存选人草稿失败'));
    } finally {
      setExitBusy(false);
    }
  }

  async function exitAndDiscard() {
    if (exitBusy) return;
    setExitBusy(true);
    try {
      await postJson(`/api/admin/pick/${matchId}/discard`, {});
      allowHistoryExit.current = true;
      message.success('已清空选人数据，报名记录已保留');
      leaveDraft('/matches');
    } catch (error) {
      message.error(errorText(error, '清空选人数据失败'));
    } finally {
      setExitBusy(false);
    }
  }

  async function runSmartAssign() {
    if (!board || smartAssigning || clearingAssignments || busySign !== null) return;
    setSmartAssigning(true);
    try {
      await postJson('/api/admin/team/auto_assign', { matchId: board.match.id });
      dirtyRef.current = true;
      message.success('智能分配完成');
      setBattleOrderVisible(false);
      const refreshed = await reload();
      if (refreshed) focusNextTeam(refreshed.board.teams);
    } catch (error) {
      message.error(errorText(error, '智能分配失败'));
    } finally {
      setSmartAssigning(false);
    }
  }

  async function clearAllAssignments() {
    if (!board || clearingAssignments || smartAssigning || busySign !== null) return;
    setClearingAssignments(true);
    try {
      await postJson('/api/admin/team/clear_assignments', { matchId: board.match.id });
      setClearConfirmOpen(false);
      setBattleOrderVisible(false);
      dirtyRef.current = true;
      message.success('已清空所有选人（包括队长），队伍和报名记录已保留');
      await reload();
      setPosition(board?.match.captain_position || 'TOP');
    } catch (error) {
      message.error(errorText(error, '清空选人失败'));
    } finally {
      setClearingAssignments(false);
    }
  }

  async function saveAndOpenMatch() {
    if (!board || !allTeamsReady || exitBusy) return;
    setExitBusy(true);
    try {
      const latest = (await getJson(`/api/admin/pick/${matchId}`)) as unknown as DraftData;
      const ready =
        latest.board.teams.length > 0 &&
        latest.board.teams.every((team) => team.player_count >= POSITIONS.length);
      if (!ready) throw new Error('请先为每支队伍选满 5 名选手');
      dirtyRef.current = false;
      leaveDraft(`/matches/${latest.board.match.id}/lineup`);
    } catch (error) {
      message.error(errorText(error, '保存失败，请稍后重试'));
    } finally {
      setExitBusy(false);
    }
  }

  // 大屏是全屏 fixed 遮罩、内容在内部容器滚动，不需要根元素常驻预留的滚动条槽位。
  // 全局 html { scrollbar-gutter: stable } 会把视口右侧缩窄约一个滚动条宽度，
  // 导致 fixed 全屏容器和它的滚动条无法贴到浏览器最右边；这里临时取消，卸载时恢复。
  useEffect(() => {
    const root = document.documentElement;
    const previousGutter = root.style.scrollbarGutter;
    root.style.scrollbarGutter = 'auto';
    return () => {
      root.style.scrollbarGutter = previousGutter;
    };
  }, []);

  const board = data?.board;
  const maxTeams = board ? maxTeamsFor(board.match.bo) : null;
  const canProceed =
    maxTeams !== null ? selectedTeams.length === maxTeams : selectedTeams.length >= 2;
  const allSigns = data?.signs ?? [];
  const selectedTeamKeys = new Set(selectedTeams.map(teamKey));
  const captainTeams = board?.match.captain_position
    ? board.teams.filter(
        (team) => team.captain_signup_id || data?.signs.some((sign) => sign.team_id === team.id),
      )
    : (board?.teams ?? []);
  const teams = captainTeams.filter((team) => selectedTeamKeys.has(teamKey(team.name)));
  const missingCaptainSettings = allSigns.filter(
    (sign) => sign.is_captain && !sign.is_waitlisted && !sign.captain_team_ready,
  );
  const hasDraftPicks = allSigns.some((sign) => sign.team_id && !sign.is_captain);
  const settingsBlocked = Boolean(
    board?.match.captain_position && !hasDraftPicks && missingCaptainSettings.length,
  );
  const allTeams = captainTeams;
  const allTeamsReady =
    allTeams.length > 0 && allTeams.every((team) => team.player_count >= POSITIONS.length);
  const showBattleOrder = allTeamsReady && battleOrderVisible;
  const battleTeams = [...allTeams].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const visibleTeams = [...teams].sort(
    (a, b) =>
      (showBattleOrder ? a.sort_order - b.sort_order : a.draft_order - b.draft_order) ||
      a.id - b.id,
  );
  const canReorderBattleTeams = showBattleOrder && teams.length === allTeams.length;
  const customTeams = board?.match.captain_position
    ? captainTeams
    : (board?.teams.filter((team) => !PRESET_TEAM_KEYS.has(teamKey(team.name))) ?? []);
  const candidates = useMemo(
    () => allSigns.filter((sign) => !sign.team_id).sort(candidateCompare),
    [allSigns],
  );
  const hasWaitlistCandidates = candidates.some((sign) => sign.is_waitlisted);
  const positionCandidates = useMemo(
    () =>
      candidates.filter((sign) => {
        const matchesPosition =
          position === WAITLIST_CATEGORY
            ? sign.is_waitlisted
            : !sign.is_waitlisted &&
              (position === FLEX_POSITION
                ? sign.can_substitute
                : sign.main_pos === position || sign.sub_pos === position || sign.can_substitute);
        const matchesRank = rankFilter === 'all' || sign.rank === rankFilter;
        return matchesPosition && matchesRank;
      }),
    [candidates, position, rankFilter],
  );
  const targetTeam = teams.find((team) => team.id === targetTeamId) ?? teams[0];
  const targetMembers = allSigns.filter((sign) => sign.team_id === targetTeam?.id);
  const availablePositionOptions = allTeamsReady
    ? PICK_CATEGORIES.filter(({ value }) => value !== WAITLIST_CATEGORY || hasWaitlistCandidates)
    : [
        ...POSITIONS.filter(
          ({ value }) => !targetMembers.some((member) => member.team_pos === value),
        ),
        ...(hasWaitlistCandidates ? [{ value: WAITLIST_CATEGORY, label: '候补' }] : []),
      ];
  const positionAvailable = availablePositionOptions.some(({ value }) => value === position);
  const firstAvailablePosition = availablePositionOptions[0]?.value ?? 'TOP';
  useEffect(() => {
    if (!positionAvailable) setPosition(firstAvailablePosition);
  }, [firstAvailablePosition, position, positionAvailable]);
  const targetMemberCount = targetMembers.length;
  const positionOccupied = Boolean(
    position &&
    position !== FLEX_POSITION &&
    targetMembers.some((sign) => sign.team_pos === position),
  );

  function assignmentPosition(sign: Sign) {
    if (!targetTeam) return '';
    const occupied = new Set(targetMembers.map((member) => member.team_pos).filter(Boolean));
    // 优先选手报名时的主位置，其次副位置，再按位置顺序补位；
    // 不因当前分类强制改派，避免副位置/补位选手被塞到错误分路。
    const desired = [sign.main_pos, sign.sub_pos, ...POSITIONS.map(({ value }) => value)];
    return (
      [...new Set(desired)].find(
        (role) => POSITIONS.some(({ value }) => value === role) && !occupied.has(role),
      ) ?? ''
    );
  }

  function canPickForTarget(sign: Sign) {
    if (settingsBlocked) return false;
    if (
      targetTeam?.captain_signup_id &&
      sign.is_captain &&
      targetTeam.captain_signup_id !== sign.id
    )
      return false;
    const captainPosition = board?.match.captain_position;
    if (captainPosition) {
      if (!targetMemberCount && sign.main_pos !== captainPosition) return false;
      if (
        sign.main_pos === captainPosition &&
        targetMembers.some((member) => member.main_pos === captainPosition)
      )
        return false;
    }
    return (
      Boolean(targetTeam) &&
      targetMemberCount < POSITIONS.length &&
      !positionOccupied &&
      Boolean(assignmentPosition(sign))
    );
  }

  function focusNextTeam(teamRows: Team[]) {
    const selectable = teamRows
      .filter((team) => selectedTeamKeys.has(teamKey(team.name)))
      .sort((a, b) => a.draft_order - b.draft_order || a.id - b.id);
    if (!selectable.length) return;
    const minimum = Math.min(...selectable.map((team) => team.player_count));
    const next = selectable.find((team) => team.player_count === minimum);
    if (next) setTargetTeamId(next.id);
  }

  function toggleTeam(teamName: string) {
    if (selectedTeams.includes(teamName)) {
      const next = selectedTeams.filter((name) => name !== teamName);
      if (
        teamKey(teams.find((team) => team.id === targetTeamId)?.name ?? '') === teamKey(teamName)
      ) {
        setTargetTeamId(
          board?.teams.find((team) => next.some((name) => teamKey(name) === teamKey(team.name)))
            ?.id ?? null,
        );
      }
      setSelectedTeams(next);
      dirtyRef.current = true;
      return;
    }
    if (maxTeams !== null && selectedTeams.length >= maxTeams) {
      message.info(teamLimitHint(board?.match.bo ?? ''));
      return;
    }
    setSelectedTeams([...selectedTeams, teamName]);
    dirtyRef.current = true;
  }

  async function continueWithTeams() {
    if (!board || !canProceed || savingTeams) return;
    if (settingsBlocked) {
      message.warning('请等待本场队长完成队伍设置');
      return;
    }
    setSavingTeams(true);
    try {
      const existingNames = new Set(board.teams.map((team) => teamKey(team.name)));
      for (const name of selectedTeams) {
        if (existingNames.has(teamKey(name))) continue;
        if (board.match.captain_position) throw Error('队伍信息已更新，请重新选择本场队长队伍');
        await postJson('/api/admin/team/create', { matchId: board.match.id, name });
        existingNames.add(teamKey(name));
      }
      const refreshed = (await getJson(`/api/admin/pick/${matchId}`)) as unknown as DraftData;
      setData(refreshed);
      const selectedExisting = refreshed.board.teams.filter((team) =>
        selectedTeams.some((name) => teamKey(name) === teamKey(team.name)),
      );
      setTargetTeamId(selectedExisting[0]?.id ?? null);
      setBattleOrderVisible(false);
      setPosition(refreshed.board.match.captain_position || 'TOP');
      dirtyRef.current = true;
      setStage('workspace');
    } catch (error) {
      message.error(errorText(error, '队伍创建失败'));
    } finally {
      setSavingTeams(false);
    }
  }

  async function reorderBattleTeams(sourceId: number, targetId: number) {
    if (!board || !canReorderBattleTeams || sourceId === targetId || reorderingTeams) return;
    const nextOrder = [...battleTeams];
    const sourceIndex = nextOrder.findIndex((team) => team.id === sourceId);
    const targetIndex = nextOrder.findIndex((team) => team.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    [nextOrder[sourceIndex], nextOrder[targetIndex]] = [
      nextOrder[targetIndex],
      nextOrder[sourceIndex],
    ];
    setReorderingTeams(true);
    try {
      await postJson('/api/admin/team/reorder', {
        matchId: board.match.id,
        teamIds: nextOrder.map((team) => team.id),
      });
      dirtyRef.current = true;
      message.success('对战顺序已更新');
      await reload();
    } catch (error) {
      message.error(errorText(error, '更新对战顺序失败'));
    } finally {
      setReorderingTeams(false);
    }
  }

  async function pick(sign: Sign) {
    if (!targetTeam || busySign !== null) return;
    const minimumBudget = targetTeam.used_fee + sign.fee;
    if (
      board?.match.use_fee &&
      board.budget > 0 &&
      minimumBudget > board.budget &&
      overrideBudget < minimumBudget
    ) {
      setBudgetBlock({ sign, minimum: minimumBudget });
      setOverrideBudget(minimumBudget);
      return;
    }
    setBusySign(sign.id);
    try {
      await postJson('/api/admin/team/assign', {
        signId: sign.id,
        teamId: targetTeam.id,
        teamPosition: assignmentPosition(sign) || null,
        overrideBudget: overrideBudget >= minimumBudget ? overrideBudget : undefined,
        draftTeamIds: teams.map((team) => team.id),
      });
      setBudgetBlock(null);
      setOverrideBudget(0);
      setBattleOrderVisible(false);
      message.success(
        `${sign.game_name || sign.yy_name || sign.username} 已加入 ${targetTeam.name}`,
      );
      dirtyRef.current = true;
      await playFlyAnimation(sign.id, targetTeam.id);
      const refreshed = await reload();
      if (refreshed) focusNextTeam(refreshed.board.teams);
    } catch (error) {
      message.error(errorText(error, '选人失败，请检查队伍人数和预算'));
    } finally {
      setBusySign(null);
    }
  }

  async function removeFromTeam(sign: Sign) {
    if (!sign.team_id || busySign !== null) return;

    setBusySign(sign.id);
    try {
      await postJson('/api/admin/team/assign', { signId: sign.id, teamId: null });
      setPendingRemoval(null);
      dirtyRef.current = true;
      message.success(`${sign.game_name || sign.yy_name || sign.username} 已退回待选池`);
      await reload();
    } catch (error) {
      message.error(errorText(error, '取消选人失败'));
    } finally {
      setBusySign(null);
    }
  }

  function playFlyAnimation(signId: number, teamId: number) {
    return new Promise<void>((resolve) => {
      const source = document.querySelector<HTMLElement>(`[data-sign-id="${signId}"]`);
      if (!source) return resolve();
      const bounds = source.getBoundingClientRect();
      const clone = source.cloneNode(true) as HTMLElement;
      clone.classList.add('big-draft-flying-card');
      Object.assign(clone.style, {
        left: `${bounds.left}px`,
        top: `${bounds.top}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
      });
      (document.querySelector('.big-draft') || document.body).appendChild(clone);
      window.setTimeout(resolve, 850);
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          const target = document.querySelector<HTMLElement>(`[data-team-id="${teamId}"]`);
          const targetBounds = target?.getBoundingClientRect();
          const destinationX =
            (targetBounds ? targetBounds.left + targetBounds.width / 2 : window.innerWidth * 0.13) -
            (bounds.left + bounds.width / 2);
          const destinationY =
            (targetBounds
              ? targetBounds.top + targetBounds.height * 0.45
              : window.innerHeight * 0.42) -
            (bounds.top + bounds.height / 2);
          const animation = clone.animate(
            [
              { transform: 'translate(0, 0) scale(1)', opacity: 1 },
              {
                transform: `translate(${destinationX}px, ${destinationY}px) scale(.14)`,
                opacity: 0.1,
              },
            ],
            { duration: 680, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
          );
          animation.onfinish = () => {
            clone.remove();
            resolve();
          };
        }),
      );
    });
  }

  if (loading && !data) {
    return (
      <main className="big-draft-loading">
        <Spin size="large" />
      </main>
    );
  }
  if (!board) {
    return (
      <main className="big-draft-loading">
        <div>
          <Empty description="无法读取赛事选人数据" />
          <Space>
            <Button onClick={() => void reload()}>重试</Button>
            <Button onClick={() => leaveDraft('/matches')}>返回赛事管理</Button>
          </Space>
        </div>
      </main>
    );
  }

  return (
    <main className="big-draft">
      <DraftMusicPlayer
        key={musicTracks.map((track) => track.src).join('|')}
        tracks={musicTracks}
      />
      {stage === 'teams' ? (
        <section className="big-draft-stage big-draft-team-stage">
          <div className="big-draft-leagues">
            {settingsBlocked && (
              <p role="status">
                等待 {missingCaptainSettings.length} 位队长完成「队伍设置」：
                {missingCaptainSettings.map((sign) => sign.game_name || sign.username).join('、')}
              </p>
            )}
            {board.match.captain_position && !customTeams.length && (
              <Empty description="队长完成队伍设置后，将在这里显示本场队伍" />
            )}
            {!board.match.captain_position &&
              TEAMS_BY_LEAGUE.map(({ league, teams: leagueTeams }) => (
                <section className="big-draft-league" key={league}>
                  <h2>{LEAGUE_LABEL[league]}</h2>
                  <div className="big-draft-league-teams">
                    {leagueTeams.map((team) => {
                      const selected = selectedTeams.some(
                        (name) => teamKey(name) === teamKey(team.name),
                      );
                      return (
                        <button
                          key={team.name}
                          className={`big-draft-league-team${selected ? ' is-selected' : ''}`}
                          aria-label={team.name}
                          aria-pressed={selected}
                          onClick={() => toggleTeam(team.name)}
                        >
                          <img src={team.logo} alt="" />
                          <span>{team.name}</span>
                          {selected ? (
                            <i>
                              <CheckOutlined />
                            </i>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            {customTeams.length ? (
              <section className="big-draft-league">
                <h2>{board.match.captain_position ? '本场队长队伍' : LEAGUE_LABEL.OTHER}</h2>
                <div className="big-draft-league-teams">
                  {customTeams.map((team) => {
                    const selected = selectedTeams.some(
                      (name) => teamKey(name) === teamKey(team.name),
                    );
                    return (
                      <button
                        key={team.id}
                        className={`big-draft-league-team${selected ? ' is-selected' : ''}`}
                        aria-label={team.name}
                        aria-pressed={selected}
                        onClick={() => toggleTeam(team.name)}
                      >
                        {teamLogo(team.name, team.logo) ? (
                          <img src={teamLogo(team.name, team.logo)} alt="" />
                        ) : (
                          <TeamOutlined />
                        )}
                        <span>{team.name}</span>
                        {selected ? (
                          <i>
                            <CheckOutlined />
                          </i>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}
          </div>
          <div className="big-draft-team-nav">
            <Button onClick={requestExit}>退出</Button>
            <Button
              type="primary"
              loading={savingTeams}
              disabled={!canProceed || settingsBlocked}
              onClick={() => void continueWithTeams()}
            >
              前进 →
            </Button>
          </div>
        </section>
      ) : (
        <section className="big-draft-workspace">
          <DraftTeams
            teams={visibleTeams}
            allTeams={allTeams}
            battleTeams={battleTeams}
            signs={allSigns}
            targetTeamId={targetTeam?.id ?? null}
            onTargetTeam={setTargetTeamId}
            useFee={board.match.use_fee}
            budget={board.budget}
            allTeamsReady={allTeamsReady}
            showBattleOrder={showBattleOrder}
            onToggleOrder={() => setBattleOrderVisible((visible) => !visible)}
            canReorderBattleTeams={canReorderBattleTeams}
            onReorderTeams={(sourceId, targetId) => void reorderBattleTeams(sourceId, targetId)}
            onUnassign={(sign) => setPendingRemoval(sign)}
          />
          <div className="big-draft-pool">
            {settingsBlocked && (
              <p role="status">
                等待 {missingCaptainSettings.length} 位队长完成队伍设置，暂不能开始选人。
              </p>
            )}
            <div className="big-draft-pool-head">
              <div>
                <h1>
                  {position === WAITLIST_CATEGORY
                    ? '候补'
                    : position === FLEX_POSITION
                      ? '补位'
                      : positionText(position)}
                </h1>
                <p>点击选手加入 {targetTeam?.name ?? '当前队伍'}</p>
              </div>
              <div className="big-draft-pool-actions">
                <Button
                  icon={<ThunderboltOutlined />}
                  loading={smartAssigning}
                  disabled={settingsBlocked || clearingAssignments || busySign !== null}
                  onClick={() => void runSmartAssign()}
                >
                  智能分配
                </Button>
                {can(viewer, 'draft.reset') && (
                  <Button
                    danger
                    icon={<ClearOutlined />}
                    disabled={smartAssigning || clearingAssignments || busySign !== null}
                    onClick={() => setClearConfirmOpen(true)}
                  >
                    清空选人
                  </Button>
                )}
                <Button icon={<ArrowLeftOutlined />} onClick={() => setStage('teams')}>
                  返回队伍选择
                </Button>
                <Button icon={<LogoutOutlined />} onClick={requestExit}>
                  退出
                </Button>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={exitBusy}
                  disabled={!allTeamsReady || settingsBlocked}
                  onClick={() => void saveAndOpenMatch()}
                >
                  保存并查看对阵
                </Button>
              </div>
            </div>
            <div className="big-draft-category-tabs" role="tablist" aria-label="待选位置分类">
              {availablePositionOptions.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={position === value}
                  className={`big-draft-category-tab${position === value ? ' is-active' : ''}`}
                  onClick={() => setPosition(value)}
                >
                  <strong>{value === FLEX_POSITION ? label : value}</strong>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <div className="big-draft-rank-filter" role="group" aria-label="段位选取">
              <span className="big-draft-rank-filter-label">段位</span>
              <button
                type="button"
                className={`big-draft-rank-chip${rankFilter === 'all' ? ' is-active' : ''}`}
                aria-pressed={rankFilter === 'all'}
                onClick={() => setRankFilter('all')}
              >
                全部
              </button>
              {RANK_FILTER_VALUES.map((rank) => (
                <button
                  key={rank}
                  type="button"
                  className={`big-draft-rank-chip${rankFilter === rank ? ' is-active' : ''}`}
                  aria-pressed={rankFilter === rank}
                  aria-label={rank}
                  title={rank}
                  onClick={() => setRankFilter(rank)}
                >
                  <RankLabel rank={rank} iconOnly />
                </button>
              ))}
            </div>
            <div
              className={`big-draft-full-player-grid${positionCandidates.length === 0 ? ' is-empty' : ''}`}
            >
              {positionCandidates.map((sign, index) => (
                <PlayerCard
                  key={sign.id}
                  sign={sign}
                  place={index + 1}
                  onPick={() => void pick(sign)}
                  busy={busySign === sign.id}
                  disabled={!canPickForTarget(sign)}
                />
              ))}
              {positionCandidates.length === 0 ? <Empty description="该分类暂无可选选手" /> : null}
            </div>
            {positionOccupied ? (
              <p className="big-draft-inline-hint">
                {targetTeam?.name} 的{positionText(position)}位置已有人，请切换队伍后继续。
              </p>
            ) : null}
          </div>
        </section>
      )}
      <Modal
        title="清空当前所有选人？"
        open={clearConfirmOpen}
        zIndex={1300}
        onCancel={() => setClearConfirmOpen(false)}
        okText="清空选人（包括队长）"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: clearingAssignments }}
        cancelButtonProps={{ disabled: clearingAssignments }}
        onOk={() => void clearAllAssignments()}
      >
        <p>此操作会将本场赛事所有队伍中的选手（包括队长）移回待选池，并保留队伍及报名记录。</p>
      </Modal>
      <Modal
        title="取消选择该选手？"
        open={Boolean(pendingRemoval)}
        zIndex={1300}
        onCancel={() => setPendingRemoval(null)}
        okText="取消选择并退回待选池"
        cancelText="继续保留"
        confirmLoading={busySign !== null}
        onOk={() => pendingRemoval && void removeFromTeam(pendingRemoval)}
      >
        <p>
          确认将 {pendingRemoval?.game_name || pendingRemoval?.yy_name || pendingRemoval?.username}{' '}
          移回待选池吗？
        </p>
      </Modal>
      <Modal
        title="返回前保存选人草稿？"
        open={exitPromptOpen}
        zIndex={1300}
        onCancel={closeExitPrompt}
        closable={!exitBusy}
        mask={{ closable: !exitBusy }}
        footer={[
          <Button key="continue" disabled={exitBusy} onClick={closeExitPrompt}>
            继续选人
          </Button>,
          can(viewer, 'draft.reset') && (
            <Button key="discard" danger loading={exitBusy} onClick={() => void exitAndDiscard()}>
              不保存并清空
            </Button>
          ),
          <Button key="save" type="primary" loading={exitBusy} onClick={() => void exitWithDraft()}>
            保存草稿并返回
          </Button>,
        ]}
      >
        <p>保存草稿会保留当前已创建的队伍和选人数据；不保存会清空这些数据，但会保留报名记录。</p>
      </Modal>
      <Modal
        title="队伍预算不足"
        open={Boolean(budgetBlock)}
        zIndex={1300}
        okText="确认并继续选人"
        cancelText="取消"
        onCancel={() => {
          setBudgetBlock(null);
          setOverrideBudget(0);
        }}
        onOk={() => {
          const sign = budgetBlock?.sign;
          if (sign) void pick(sign);
        }}
      >
        <p>本次分配会超过赛事预算限制。输入本次使用的新预算上限后继续，调整仅影响此次分配。</p>
        <InputNumber
          min={budgetBlock?.minimum ?? 1}
          value={overrideBudget}
          onChange={(value) => setOverrideBudget(Number(value ?? 0))}
          style={{ width: '100%' }}
        />
      </Modal>
    </main>
  );
}

function PlayerCard({
  sign,
  place,
  onPick,
  busy,
  disabled = false,
}: {
  sign: Sign;
  place: number;
  onPick: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-sign-id={sign.id}
      className="big-draft-player-card"
      onClick={onPick}
      disabled={busy || disabled}
    >
      <span className="big-draft-player-place">#{String(place).padStart(2, '0')}</span>
      {sign.is_captain ? <span className="big-draft-player-captain">队长</span> : null}
      {sign.is_off_role ? (
        <span
          className="big-draft-off-role-badge big-draft-player-off-role"
          title="报名位置不属于个人主位置或副位置"
        >
          补位
        </span>
      ) : null}
      <Avatar size={70} src={sign.avatar || undefined}>
        {(sign.game_name || sign.yy_name || sign.username).slice(0, 1)}
      </Avatar>
      <strong>{sign.game_name || sign.yy_name || sign.username}</strong>
      <div className="big-draft-player-stats">
        <span className="big-draft-player-rank">
          <RankLabel
            rank={sign.rank}
            iconOnly
            fallback="未定段"
            draftRank={sign.fee_card_active ? sign.draft_rank : null}
          />
        </span>
        <span>
          <b>KDA {sign.kda.toFixed(2)}</b>
        </span>
      </div>
      <RecentForm recent={sign.recent} className="big-draft-player-recent" />
      <span className="big-draft-pick-hint">
        {busy ? (
          <Spin size="small" />
        ) : (
          <>
            选择选手 <b>→</b>
          </>
        )}
      </span>
    </button>
  );
}

function DraftTeams({
  teams,
  allTeams,
  battleTeams,
  signs,
  targetTeamId,
  onTargetTeam,
  useFee,
  budget,
  allTeamsReady,
  showBattleOrder,
  onToggleOrder,
  canReorderBattleTeams,
  onReorderTeams,
  onUnassign,
}: {
  teams: Team[];
  allTeams: Team[];
  battleTeams: Team[];
  signs: Sign[];
  targetTeamId: number | null;
  onTargetTeam: (teamId: number) => void;
  useFee: boolean;
  budget: number;
  allTeamsReady: boolean;
  showBattleOrder: boolean;
  onToggleOrder: () => void;
  canReorderBattleTeams: boolean;
  onReorderTeams: (sourceId: number, targetId: number) => void;
  onUnassign: (sign: Sign) => void;
}) {
  const [dragTeamId, setDragTeamId] = useState<number | null>(null);

  // 当前选人目标队伍变化时，自动滚动到可视区域，避免队伍在列表下方被挡住。
  useEffect(() => {
    if (targetTeamId == null) return;
    const element = document.querySelector<HTMLElement>(`[data-team-group-id="${targetTeamId}"]`);
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [targetTeamId]);

  return (
    <aside className="big-draft-roster">
      <div className="big-draft-roster-caption">
        <span>
          {canReorderBattleTeams
            ? '对战顺序（拖动队伍卡片可调整）'
            : showBattleOrder
              ? '对战顺序（需显示全部队伍后调整）'
              : '选人顺序 · 每轮按费用重排，同费随机'}
        </span>
        {allTeamsReady ? (
          <Button size="small" onClick={onToggleOrder}>
            {showBattleOrder ? '查看选人顺序' : '调整对战顺序'}
          </Button>
        ) : null}
        {useFee && budget > 0 ? <small>单队预算 {budget}</small> : null}
      </div>
      <div className="big-draft-roster-list">
        {teams.map((team) => {
          const members = signs.filter((sign) => sign.team_id === team.id);
          const rosterMembers = [...members].sort(
            (a, b) =>
              Number(Boolean(b.is_captain)) - Number(Boolean(a.is_captain)) ||
              (a.pos_order ?? a.id) - (b.pos_order ?? b.id) ||
              a.id - b.id,
          );
          const pickIndex =
            [...allTeams]
              .sort((a, b) => a.draft_order - b.draft_order || a.id - b.id)
              .findIndex((item) => item.id === team.id) + 1;
          const battleIndex = battleTeams.findIndex((item) => item.id === team.id);
          const opponent =
            battleTeams[battleIndex % 2 === 0 ? battleIndex + 1 : battleIndex - 1]?.name ?? '待定';
          const isActive = team.id === targetTeamId;
          const logo = teamLogo(team.name, team.logo);
          return (
            <div
              className={`big-draft-roster-group${isActive ? ' is-active' : ''}${dragTeamId === team.id ? ' is-dragging' : ''}`}
              key={team.id}
              data-team-group-id={team.id}
              role="group"
              aria-label={`${team.name}${isActive ? '，当前队伍' : ''}`}
              draggable={canReorderBattleTeams}
              onDragStart={(event) => {
                if (!canReorderBattleTeams) return;
                setDragTeamId(team.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (canReorderBattleTeams) event.preventDefault();
              }}
              onDrop={(event) => {
                if (!canReorderBattleTeams || dragTeamId === null) return;
                event.preventDefault();
                onReorderTeams(dragTeamId, team.id);
                setDragTeamId(null);
              }}
              onDragEnd={() => setDragTeamId(null)}
            >
              {isActive && logo ? (
                <span className="big-draft-team-watermark" aria-hidden="true">
                  <img src={logo} alt="" decoding="async" />
                </span>
              ) : null}
              <button
                data-team-id={team.id}
                className={`big-draft-roster-team${isActive ? ' is-active' : ''}`}
                aria-pressed={isActive}
                onClick={() => onTargetTeam(team.id)}
              >
                <span className="big-draft-roster-team-logo">
                  {logo ? <img src={logo} alt="" /> : <TeamOutlined />}
                </span>
                <span className="big-draft-roster-team-head">
                  <strong>{team.name}</strong>
                  {isActive ? (
                    <span className="big-draft-current-team-badge">
                      {allTeamsReady ? '当前队伍' : '当前选人'}
                    </span>
                  ) : null}
                  <small>{members.length}/5</small>
                </span>
              </button>
              <div className="big-draft-roster-team-meta">
                <span>选人顺位 {pickIndex}</span>
                <span>
                  对战 {battleIndex + 1} · 对手 {opponent}
                </span>
                {useFee ? (
                  <span className={budget > 0 && team.used_fee > budget ? 'is-over-budget' : ''}>
                    费用 {team.used_fee}
                    {budget > 0 ? ` / ${budget}` : ''}
                  </span>
                ) : null}
              </div>
              <div className="big-draft-roster-slots">
                {POSITIONS.map(({ value, label }) => {
                  const member = rosterMembers.find((sign) => sign.team_pos === value);
                  const isCaptain = Boolean(member?.is_captain);
                  return (
                    <div
                      key={value}
                      className={`big-draft-roster-slot${member ? ' filled' : ''}`}
                      role={member ? 'button' : undefined}
                      tabIndex={member ? 0 : undefined}
                      title={member ? '点击后可将该选手退回待选池' : undefined}
                      onClick={() => member && onUnassign(member)}
                      onKeyDown={(event) => {
                        if (member && (event.key === 'Enter' || event.key === ' ')) {
                          event.preventDefault();
                          onUnassign(member);
                        }
                      }}
                    >
                      <i>
                        {label}
                        {member?.is_off_role ? (
                          <span
                            className="big-draft-off-role-badge"
                            title="报名位置不属于个人主位置或副位置"
                          >
                            补位
                          </span>
                        ) : null}
                      </i>
                      <strong className={member ? undefined : 'big-draft-empty-slot'}>
                        {member
                          ? member.game_name || member.yy_name || member.username
                          : '等待选人'}
                      </strong>
                      {isCaptain ? <em className="big-draft-captain-badge">队长</em> : null}
                      {member ? (
                        <small>
                          <RankLabel
                            className="big-draft-roster-rank"
                            rank={member.rank}
                            iconOnly
                            draftRank={member.fee_card_active ? member.draft_rank : null}
                            fallback="未定段"
                          />
                          {'kda' in member ? (
                            <span>KDA {Number(member.kda).toFixed(2)}</span>
                          ) : null}
                        </small>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
