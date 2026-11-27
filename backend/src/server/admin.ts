import {
  BO_OPTIONS as BO_LIST,
  CUSTOM_FORMAT,
  CUSTOM_TEAM_COUNTS,
  ROUND_FORMATS,
  matchTeamLimit,
  matchFormatLabel,
  meetsSignupRank,
  MATCH_STATUSES,
  RANKS,
  REVIEW_STATUSES,
  normalizeRank,
  positionText,
  isOffRole,
  type ReviewStatus,
} from '@/lib/admin-options';
import { Prisma, type Match } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isLineupReady } from '@/lib/lineup-readiness';
import { feeCardDisplay } from '@/lib/fee-reduction';
import { refundMatchFeeCards } from '@/server/fee-card-use';
import {
  activeMatchTeamWhere,
  cleanupCaptainLogo,
  releaseCaptainTeam,
  syncCaptainTeams,
} from '@/server/captain-teams';
import { GAME_NAME_HINT, isValidGameName } from '@/lib/game-name';
import { randomDefaultAvatar } from '@/lib/default-avatars';
import bcrypt from 'bcryptjs';
import { ApiError, badRequest, forbidden, notFound } from '@/server/api';
import {
  adminLevelOf,
  assertCanManageUser,
  assertSecondaryAdmin,
  isCoreAdminActor,
  statusStillBlocked,
} from '@/server/permissions';
import {
  budgetForTeamCount,
  isBracketTeamCount,
  isPosition,
  pairTeams,
  POSITIONS,
  rankFee,
  signRank,
  totalRoundsFor,
} from '@/server/roster';
import { consumeMatchHeroProtections } from '@/server/hero-protection';
import { rebalanceSignupWaitlist, removeSignupAndPromote } from '@/lib/repository';

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** 管理员重置用户密码时统一设置的固定初始密码。 */
const RESET_PASSWORD = 'lxl123456';

/** 把前端传来的可空排期时间（ISO 字符串）解析成 Date；未传/空串/非法一律返回 null。 */
function parseMatchDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function requireMatch(matchId: number) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) throw notFound('赛事不存在');
  return match;
}

function matchFormatSettings(bo: string, body: Record<string, unknown>) {
  if (!BO_LIST.includes(bo)) throw badRequest('赛制无效');
  if (bo !== CUSTOM_FORMAT)
    return { bo, customTeamCount: 0, roundFormats: [], minSignupRank: '', allowItemCards: true };

  const customTeamCount = body.custom_team_count;
  if (typeof customTeamCount !== 'number' || !CUSTOM_TEAM_COUNTS.includes(customTeamCount))
    throw badRequest('请选择 20、30 或 40 人');
  const roundFormats = body.round_formats;
  if (
    !Array.isArray(roundFormats) ||
    roundFormats.length !== totalRoundsFor(customTeamCount) ||
    roundFormats.some((format) => !ROUND_FORMATS.includes(format))
  )
    throw badRequest('请为每一轮选择 BO1、BO3 或 BO5');
  const minSignupRank = asText(body.min_signup_rank);
  if (
    (body.min_signup_rank !== undefined && typeof body.min_signup_rank !== 'string') ||
    (minSignupRank && normalizeRank(minSignupRank) !== minSignupRank)
  )
    throw badRequest('最低报名段位无效');
  const allowItemCards = body.allow_item_cards;
  if (allowItemCards !== undefined && typeof allowItemCards !== 'boolean')
    throw badRequest('是否允许使用道具卡必须为布尔值');
  return { bo, customTeamCount, roundFormats, minSignupRank, allowItemCards };
}

async function parseSignupPassword(value: unknown) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 72)
    throw badRequest('请输入有效的报名密码，最多 72 字节');
  return bcrypt.hash(value, 10);
}

export async function createMatch(adminId: number, body: Record<string, unknown>) {
  const name = asText(body.name);
  if (!name) throw badRequest('比赛名称不能为空');

  const format = matchFormatSettings(asText(body.bo) || 'BO3', body);
  const signupPasswordHash =
    format.bo === CUSTOM_FORMAT && body.signup_password !== ''
      ? await parseSignupPassword(body.signup_password)
      : null;
  const round = asText(body.round) || '常规赛';
  const captainPosition = asText(body.captain_position);
  if (captainPosition && !isPosition(captainPosition)) throw badRequest('队长分路不合法');

  const nameKey = name.slice(0, 100);
  if (await prisma.match.findFirst({ where: { name: nameKey } })) {
    throw badRequest('赛事名称已存在，不能重复');
  }

  const match = await prisma.match.create({
    data: {
      name: name.slice(0, 100),
      status: 'CREATED',
      ...format,
      allowItemCards: format.allowItemCards ?? true,
      signupPasswordHash,
      round: round.slice(0, 40),
      useFee: body.use_fee === undefined ? true : Boolean(body.use_fee),
      captainPosition,
      date: parseMatchDate(body.date),
      playerCount: 0,
      teamCount: 0,
      createdById: adminId,
    },
  });
  return { msg: '比赛已创建', id: match.id };
}

export async function updateMatch(
  matchId: number,
  body: Record<string, unknown>,
  actorId?: number,
) {
  if (body.status !== undefined)
    throw badRequest('赛事状态由“结束选人并开赛”和“结束本轮”自动更新，不能手动修改');
  const format = body.bo === undefined ? undefined : matchFormatSettings(asText(body.bo), body);
  const signupPasswordHash = await parseSignupPassword(body.signup_password);
  const isCoreAdmin = actorId !== undefined && (await isCoreAdminActor(actorId));
  const removedTeamLogos: string[] = [];
  const suffix = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match) throw notFound('赛事不存在');
    const started = match.status !== 'CREATED';
    const data: Prisma.MatchUpdateInput = {};
    if (signupPasswordHash !== undefined) {
      if (started || (format?.bo ?? match.bo) !== CUSTOM_FORMAT)
        throw badRequest('只有待选人阶段的自定义赛事可以设置报名密码');
      data.signupPasswordHash = signupPasswordHash;
    }
    const name = asText(body.name).slice(0, 100);
    if (name && name !== match.name) {
      if (started && !isCoreAdmin) throw badRequest('比赛已开始，名称不可再修改');
      if (await tx.match.findFirst({ where: { name, id: { not: matchId } } }))
        throw badRequest('赛事名称已存在，不能重复');
      data.name = name;
    }
    const round = asText(body.round).slice(0, 40);
    if (round && round !== match.round) {
      if (started && !isCoreAdmin) throw badRequest('赛事已开始，轮次不可再修改');
      data.round = round;
    }
    if (body.date !== undefined) {
      const date = parseMatchDate(body.date);
      if (date?.getTime() !== match.date?.getTime()) {
        if (started && !isCoreAdmin) throw badRequest('赛事已开始，比赛时间不可再修改');
        data.date = date;
      }
    }
    const captainPosition =
      body.captain_position === undefined ? match.captainPosition : asText(body.captain_position);
    if (body.captain_position !== undefined && captainPosition && !isPosition(captainPosition))
      throw badRequest('队长分路不合法');
    if (captainPosition !== match.captainPosition) {
      if (
        started ||
        (await tx.matchFeeCardUse.count({ where: { matchId } })) ||
        (await tx.matchSignup.count({
          where: {
            matchId,
            OR: [{ teamId: { not: null } }, { feeCardInventoryId: { not: null } }],
          },
        }))
      )
        throw badRequest('已开始选人或已有报名使用降费卡，不能修改队长分路');
      data.captainPosition = captainPosition;
    }
    if (Object.keys(data).length) await tx.match.update({ where: { id: matchId }, data });
    if (captainPosition !== match.captainPosition) {
      const previous = await tx.matchSignup.findMany({
        where: { matchId, mainPosition: { not: captainPosition } },
        select: { captainTeamLogo: true },
      });
      removedTeamLogos.push(...previous.map((sign) => sign.captainTeamLogo));
      await tx.matchSignup.updateMany({
        where: { matchId, mainPosition: { not: captainPosition } },
        data: { captainTeamName: '', captainTeamLogo: '' },
      });
      await tx.matchSignup.updateMany({ where: { matchId }, data: { isCaptain: false } });
      if (captainPosition)
        await tx.matchSignup.updateMany({
          where: { matchId, mainPosition: captainPosition, isWaitlisted: false },
          data: { isCaptain: true },
        });
    }
    return format
      ? waitlistChangeText(await updateMatchFormat(tx, match, format, isCoreAdmin))
      : '';
  });
  await Promise.all([...new Set(removedTeamLogos)].map(cleanupCaptainLogo));
  return { msg: `比赛信息已更新${suffix}` };
}

/** Set a match status directly; this repair action is reserved for the core admin account. */
export async function setMatchStatus(matchId: number, status: unknown, actorId: number) {
  if (!(await isCoreAdminActor(actorId))) throw forbidden('只有核心管理员可以设置赛事状态');
  if (
    typeof status !== 'string' ||
    !MATCH_STATUSES.includes(status as (typeof MATCH_STATUSES)[number])
  ) {
    throw badRequest('赛事状态无效');
  }
  const match = await requireMatch(matchId);
  const nextStatus = status as (typeof MATCH_STATUSES)[number];
  if (match.status === nextStatus) return { msg: `赛事状态已设置为 ${status}` };
  await prisma.$transaction(async (tx) => {
    const updated = await tx.match.updateMany({
      where: { id: matchId, status: match.status },
      data: { status: nextStatus },
    });
    if (updated.count !== 1) throw badRequest('赛事状态已改变，请刷新后重试');
    if (nextStatus === 'LIVE') {
      await tx.match.update({ where: { id: matchId }, data: { feeCardFirstRoundDone: true } });
      await tx.userInventory.updateMany({
        where: {
          status: 'RESERVED',
          feeCardSignup: { matchId, isWaitlisted: false, teamId: { not: null } },
        },
        data: { status: 'USED', usedAt: new Date() },
      });
      await consumeMatchHeroProtections(tx, matchId);
    } else if (match.status === 'CREATED' || nextStatus === 'CREATED') {
      await tx.matchHeroProtection.deleteMany({ where: { matchId, card: { consumedAt: null } } });
    }
  });
  return { msg: `赛事状态已设置为 ${status}` };
}

async function updateMatchFormat(
  tx: Prisma.TransactionClient,
  match: Match,
  format: ReturnType<typeof matchFormatSettings>,
  isCoreAdmin: boolean,
) {
  const matchId = match.id;
  const custom = match.bo === CUSTOM_FORMAT || format.bo === CUSTOM_FORMAT;
  if (match.status !== 'CREATED' && (custom || !isCoreAdmin))
    throw badRequest('赛事已开始，赛制不可再修改');
  const oldLimit = matchTeamLimit(match.bo, match.customTeamCount);
  const newLimit = matchTeamLimit(format.bo, format.customTeamCount);
  if (custom) {
    if (format.allowItemCards === false && match.allowItemCards) {
      const [feeUse, allInUse, heroUse, feeSignup] = await Promise.all([
        tx.matchFeeCardUse.count({ where: { matchId } }),
        tx.matchAllInCardUse.count({ where: { matchId } }),
        tx.heroProtectionCard.count({
          where: { usedMatchId: matchId, consumedAt: { not: null } },
        }),
        tx.matchSignup.count({ where: { matchId, feeCardInventoryId: { not: null } } }),
      ]);
      if (feeUse || allInUse || heroUse || feeSignup)
        throw badRequest('本场赛事已有道具卡使用记录，无法关闭道具卡');
      await tx.matchHeroProtection.deleteMany({ where: { matchId, card: { consumedAt: null } } });
    }
    if (
      oldLimit !== newLimit &&
      (await tx.matchSignup.count({
        where: { matchId, teamId: { not: null } },
      }))
    )
      throw badRequest('已有选手入队，请先清空选人草稿再修改人数');
    if (newLimit && (await tx.team.count({ where: activeMatchTeamWhere(matchId) })) > newLimit)
      throw badRequest('现有队伍超过新赛制名额，请先调整队伍数量');
    if (format.minSignupRank && format.minSignupRank !== match.minSignupRank) {
      const signups = await tx.matchSignup.findMany({
        where: { matchId },
        select: { rankAtSignup: true, user: { select: { profile: { select: { rank: true } } } } },
      });
      if (
        signups.some(
          (signup) =>
            !meetsSignupRank(
              signup.user.profile?.rank ?? signup.rankAtSignup,
              format.minSignupRank,
            ),
        )
      )
        throw badRequest('已有报名选手低于新的最低段位，请先处理其报名');
    }
    if (
      (match.bo !== format.bo || match.roundFormats.join() !== format.roundFormats.join()) &&
      ((await tx.matchScore.count({ where: { matchId } })) ||
        (await tx.matchMarket.count({ where: { matchId } })))
    )
      throw badRequest('赛事已有比分或竞猜盘口，无法修改每轮赛制');
  }
  await tx.match.update({
    where: { id: matchId },
    data: {
      ...format,
      ...(format.bo !== CUSTOM_FORMAT && match.signupPasswordHash
        ? { signupPasswordHash: null }
        : {}),
    },
  });
  return oldLimit !== newLimit ? rebalanceSignupWaitlist(matchId, tx) : { promoted: 0, demoted: 0 };
}

function waitlistChangeText({ promoted, demoted }: { promoted: number; demoted: number }) {
  return promoted || demoted ? `（${promoted} 人递补为正式，${demoted} 人进入候补）` : '';
}

export async function setMatchBo(matchId: number, body: Record<string, unknown>, actorId?: number) {
  const format = matchFormatSettings(asText(body.bo), body);
  const isCoreAdmin = actorId !== undefined && (await isCoreAdminActor(actorId));
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match) throw notFound('赛事不存在');
    return updateMatchFormat(tx, match, format, isCoreAdmin);
  });
  return { msg: `赛制已更新为 ${matchFormatLabel(format.bo)}${waitlistChangeText(result)}` };
}

export async function setMatchFee(matchId: number, useFee: boolean, actorId?: number) {
  const match = await requireMatch(matchId);
  if (await statusStillBlocked(actorId, match.status !== 'CREATED')) {
    throw badRequest('只有待选人阶段的赛事才能修改选费设置');
  }
  const updated = await prisma.match.update({ where: { id: matchId }, data: { useFee } });
  return { msg: '已更新选费设置', use_fee: updated.useFee };
}

export async function setMatchLive(matchId: number, liveUrl: string) {
  await requireMatch(matchId);
  const url = liveUrl.trim();
  if (url && !url.startsWith('http://') && !url.startsWith('https://'))
    throw badRequest('链接必须以 http:// 或 https:// 开头');
  if (url.length > 300) throw badRequest('链接过长');
  await prisma.match.update({ where: { id: matchId }, data: { liveUrl: url } });
  return { msg: '直播链接已保存' };
}

export async function finishMatch(matchId: number, actorId?: number) {
  const match = await requireMatch(matchId);
  if (await statusStillBlocked(actorId, match.status !== 'LIVE'))
    throw badRequest('只有进行中的赛事才能结束');

  const teams = await prisma.team.findMany({
    where: activeMatchTeamWhere(matchId),
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  // 淘汰赛按轮次自动结束：结束最后一轮时 endRound 会把状态置为 FINISHED，
  // 这里禁止手动结束，避免「还没点结束本轮就能结束赛事」的漏洞。
  if (isBracketTeamCount(teams.length)) {
    throw badRequest('淘汰赛请按轮次结束：录入战果后点击「结束本轮」即可自动结束比赛');
  }

  // 结束前必须录完本场所有战果：非淘汰赛制校验当前轮。
  const finalRound = isBracketTeamCount(teams.length) ? totalRoundsFor(teams.length) : 1;
  const roundNo = Math.max(match.currentRound || 1, finalRound);
  const frozen = await prisma.matchRound.findMany({
    where: { matchId, roundNo },
    orderBy: { id: 'asc' },
  });
  const pairs: [number, number][] = frozen.length
    ? frozen.map((row) => [row.teamOneId, row.teamTwoId] as [number, number])
    : roundNo === 1
      ? pairTeams(match, teams).filter((pair): pair is [number, number] => pair[1] !== null)
      : [];
  if (!pairs.length)
    throw badRequest('该比赛还没有录入赛果，如果提前结束则不会再将该场比赛的结果发送到比赛记录');

  const scores = await prisma.matchScore.findMany({
    where: { matchId, roundNo },
    select: { teamOneId: true, teamTwoId: true },
  });
  const scored = (teamOneId: number, teamTwoId: number) =>
    scores.some(
      (score) =>
        (score.teamOneId === teamOneId && score.teamTwoId === teamTwoId) ||
        (score.teamOneId === teamTwoId && score.teamTwoId === teamOneId),
    );
  if (!pairs.every(([teamOneId, teamTwoId]) => scored(teamOneId, teamTwoId)))
    throw badRequest('该比赛还没有录入赛果，如果提前结束则不会再将该场比赛的结果发送到比赛记录');

  await prisma.match.update({
    where: { id: matchId },
    data: { status: 'FINISHED', roundEnded: true },
  });
  return { msg: '比赛已结束！' };
}

export async function finishPick(matchId: number, actorId?: number) {
  const match = await requireMatch(matchId);
  if (await statusStillBlocked(actorId, match.status !== 'CREATED'))
    throw badRequest('只有待选人阶段的赛事才能开赛');
  // 六队 / 八队模式必须先把队伍和首发凑齐，否则赛程无法按轮次推进。
  const limit = matchTeamLimit(match.bo, match.customTeamCount);
  const requiredTeams = match.bo === CUSTOM_FORMAT || limit === 6 || limit === 8 ? limit : null;
  if (requiredTeams && match.bo !== CUSTOM_FORMAT) {
    const [teams, counts] = await Promise.all([
      prisma.team.findMany({ where: activeMatchTeamWhere(matchId), select: { id: true } }),
      prisma.matchSignup.groupBy({
        by: ['teamId'],
        where: { matchId, teamId: { not: null } },
        _count: true,
      }),
    ]);
    const countsByTeam = new Map(counts.map((row) => [row.teamId, row._count]));
    if (
      teams.length !== requiredTeams ||
      teams.some((team) => (countsByTeam.get(team.id) ?? 0) !== POSITIONS.length)
    ) {
      throw badRequest(
        `${matchFormatLabel(match.bo)}需要正好 ${requiredTeams} 支队伍，且每队选满 ${POSITIONS.length} 名选手`,
      );
    }
  }
  await prisma.$transaction(async (tx) => {
    if (match.bo === CUSTOM_FORMAT) {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
      const [teams, signups] = await Promise.all([
        tx.team.findMany({ where: activeMatchTeamWhere(matchId), select: { id: true } }),
        tx.matchSignup.findMany({
          where: { matchId, teamId: { not: null } },
          select: { teamId: true, teamPosition: true, mainPosition: true, isWaitlisted: true },
        }),
      ]);
      if (!isLineupReady({ ...match, status: 'CREATED' }, teams, signups))
        throw badRequest(`自定义赛事需要正好 ${requiredTeams} 支队伍，每队五个分路均有正式选手`);
    }
    const started = await tx.match.updateMany({
      where: {
        id: matchId,
        status: 'CREATED',
        bo: match.bo,
        customTeamCount: match.customTeamCount,
      },
      data: { status: 'LIVE', feeCardFirstRoundDone: true },
    });
    if (started.count !== 1) throw badRequest('赛事状态已改变，无法开赛');
    await tx.userInventory.updateMany({
      where: {
        status: 'RESERVED',
        feeCardSignup: { matchId, isWaitlisted: false, teamId: { not: null } },
      },
      data: { status: 'USED', usedAt: new Date() },
    });

    await consumeMatchHeroProtections(tx, matchId);
  });
  return { msg: '已结束选人，赛事开始！' };
}

/** Discard a pick draft while retaining the match signups. */
export async function discardPickDraft(matchId: number, actorId?: number) {
  const match = await requireMatch(matchId);
  if (await statusStillBlocked(actorId, match.status === 'FINISHED'))
    throw badRequest('已结束赛事不能清空选人草稿');
  if (match.status === 'LIVE') {
    const [score, round, record] = await Promise.all([
      prisma.matchScore.findFirst({ where: { matchId }, select: { id: true } }),
      prisma.matchRound.findFirst({ where: { matchId }, select: { id: true } }),
      prisma.matchGameRecord.findFirst({ where: { matchId }, select: { id: true } }),
    ]);
    if (score || round || record) throw badRequest('已有赛果或固化对阵，不能清空选人草稿');
  }

  const discarded = await prisma.$transaction(async (tx) => {
    const current = await tx.match.updateMany({
      where: { id: matchId, status: match.status },
      data: {
        status: 'CREATED',
        currentRound: 1,
        roundEnded: false,
        feeCardFirstRoundDone: false,
        teamCount: 0,
        teamOneId: null,
        teamTwoId: null,
      },
    });
    if (current.count !== 1) return false;

    const signups = await tx.matchSignup.findMany({
      where: { matchId },
      select: { id: true, isWaitlisted: true, waitlistOrigin: true },
    });
    await Promise.all(
      signups.map((signup) =>
        tx.matchSignup.update({
          where: { id: signup.id },
          data: {
            teamId: null,
            teamPosition: '',
            positionOrder: 0,
            isCaptain: false,
            isWaitlisted: signup.isWaitlisted || signup.waitlistOrigin,
          },
        }),
      ),
    );
    await tx.team.deleteMany({ where: { matchId } });
    await syncCaptainTeams(tx, matchId);
    return true;
  });

  if (!discarded) throw badRequest('赛事状态已改变，不能清空选人草稿');
  return { msg: '选人草稿已清空，报名记录已保留' };
}

/** 删除赛事并级联清理报名 / 队伍 / 战绩 / 轮次 / 战果。 */
export async function deleteMatch(matchId: number, actorId?: number) {
  const level = actorId == null ? 0 : await adminLevelOf(actorId);
  if (level < 2) throw forbidden('只有二级管理员及以上可以删除赛事');
  const logos: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: matchId }, select: { status: true } });
    if (!match) throw notFound('赛事不存在');
    if (match.status !== 'CREATED') throw badRequest('只有待选人的赛事可以删除');
    const signs = await tx.matchSignup.findMany({
      where: { matchId },
      select: { captainTeamLogo: true },
    });
    const teams = await tx.team.findMany({ where: { matchId }, select: { logo: true } });
    logos.push(...signs.map((sign) => sign.captainTeamLogo), ...teams.map((team) => team.logo));
    await refundMatchFeeCards(tx, matchId);
    await tx.matchGameRecord.deleteMany({ where: { matchId } });
    await tx.matchScore.deleteMany({ where: { matchId } });
    await tx.matchRound.deleteMany({ where: { matchId } });
    await tx.matchSignup.deleteMany({ where: { matchId } });
    await tx.team.deleteMany({ where: { matchId } });
    await tx.match.delete({ where: { id: matchId } });
  });
  await Promise.all([...new Set(logos)].map(cleanupCaptainLogo));
  return { msg: '比赛已删除' };
}

/** 后台分队看板：队伍 + 每队已用费用 + 报名列表（含段位费用）。 */
export async function teamsBoard(matchId: number) {
  return (await loadTeamsBoard(matchId)).board;
}

export async function loadTeamsBoard(matchId: number) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    relationLoadStrategy: 'join',
    include: {
      teams: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      signups: {
        orderBy: [{ positionOrder: 'asc' }, { id: 'asc' }],
        include: {
          user: {
            select: {
              username: true,
              profile: {
                select: {
                  rank: true,
                  avatar: true,
                  mainPosition: true,
                  subPosition: true,
                  gameName: true,
                },
              },
            },
          },
        },
      },
      scores: {
        select: { roundNo: true, teamOneId: true, teamTwoId: true, scoreOne: true, scoreTwo: true },
      },
      rounds: { orderBy: [{ roundNo: 'asc' }, { id: 'asc' }] },
      fmvpUser: {
        select: {
          id: true,
          username: true,
          profile: { select: { gameName: true, avatar: true } },
        },
      },
    },
  });
  if (!match) throw notFound('赛事不存在');
  const roundNo = match.currentRound || 1;
  const { teams: rawTeams, rounds: allFrozenRounds, fmvpUser } = match;
  const signs = match.signups.filter((sign) => !sign.isWaitlisted);
  const scores = match.scores.filter((score) => score.roundNo === roundNo);
  const frozenRounds = allFrozenRounds.filter((round) => round.roundNo === roundNo);

  const teams = match.captainPosition
    ? rawTeams.filter(
        (team) => team.captainSignupId || signs.some((sign) => sign.teamId === team.id),
      )
    : rawTeams;

  const useFee = Boolean(match.useFee);
  const usedByTeam = new Map<number, number>();
  for (const sign of signs) {
    if (!sign.teamId) continue;
    usedByTeam.set(sign.teamId, (usedByTeam.get(sign.teamId) ?? 0) + rankFee(signRank(sign)));
  }

  // 当前轮的所有对阵（可能同时有多组对战），以及每组是否已录入比分。
  // 第 1 轮之后优先读取已固化的 MatchRound（胜者晋级后的对阵），否则现场生成。
  const roundPairs: [number, number][] = frozenRounds.length
    ? frozenRounds.map((row) => [row.teamOneId, row.teamTwoId])
    : pairTeams(match, teams).filter((pair): pair is [number, number] => pair[1] !== null);
  const scoreOf = (teamOneId: number, teamTwoId: number) => {
    const direct = scores.find(
      (score) => score.teamOneId === teamOneId && score.teamTwoId === teamTwoId,
    );
    if (direct) return [direct.scoreOne, direct.scoreTwo] as const;
    const swapped = scores.find(
      (score) => score.teamOneId === teamTwoId && score.teamTwoId === teamOneId,
    );
    if (swapped) return [swapped.scoreTwo, swapped.scoreOne] as const;
    return null;
  };
  const round_pairs = roundPairs.map(([teamOneId, teamTwoId]) => {
    const score = scoreOf(teamOneId, teamTwoId);
    return {
      team_one: teamOneId,
      team_two: teamTwoId,
      score_one: score ? score[0] : 0,
      score_two: score ? score[1] : 0,
      has_score: Boolean(score),
    };
  });
  const has_score = round_pairs.length > 0 && round_pairs.every((pair) => pair.has_score);

  const all_round_pairs = allFrozenRounds.map((row) => ({
    round_no: row.roundNo,
    team_one: row.teamOneId,
    team_two: row.teamTwoId,
  }));

  const totalFee = signs.reduce((sum, sign) => sum + rankFee(signRank(sign)), 0);
  // 与 activeMatchTeamWhere 一致：包括有历史报名关联的队伍。
  const assignedTeamIds = new Set(match.signups.map((sign) => sign.teamId));
  const budgetTeams = match.captainPosition
    ? rawTeams.filter((team) => team.captainSignupId != null || assignedTeamIds.has(team.id))
    : rawTeams;

  const board = {
    match: {
      id: match.id,
      name: match.name,
      status: match.status,
      use_fee: useFee,
      champion_team_id: match.championTeamId,
      captain_position: match.captainPosition,
      first_draft_round: match.status === 'CREATED' && !match.feeCardFirstRoundDone,
      bo: match.bo || 'BO1',
      custom_team_count: match.customTeamCount,
      round_formats: match.roundFormats,
      min_signup_rank: match.minSignupRank,
      allow_item_cards: match.allowItemCards,
      signup_password_required: Boolean(match.signupPasswordHash),
      total_rounds: match.customTeamCount
        ? totalRoundsFor(match.customTeamCount)
        : isBracketTeamCount(teams.length)
          ? totalRoundsFor(teams.length)
          : 1,
      round: match.round,
      date: match.date ? match.date.toISOString() : null,
      live_url: match.liveUrl,
      prize_pool_json: match.prizePoolJson,
      prize_distributed: match.prizeDistributed,
      team_count: rawTeams.length,
    },
    teams: teams.map((team) => ({
      id: team.id,
      match_id: team.matchId,
      name: team.name,
      sort_order: team.sortOrder,
      logo: team.logo,
      captain_signup_id: team.captainSignupId,
      draft_order: team.draftOrder,
      player_count: signs.filter((sign) => sign.teamId === team.id).length,
      used_fee: usedByTeam.get(team.id) ?? 0,
    })),
    signs: signs.map((sign) => ({
      id: sign.id,
      user_id: sign.userId,
      username: sign.user.username,
      yy_name: sign.displayName,
      game_name: sign.user.profile?.gameName ?? '',
      avatar: sign.user.profile?.avatar ?? '',
      rank: signRank(sign),
      main_pos: sign.mainPosition,
      sub_pos: sign.subPosition,
      is_off_role: isOffRole(
        sign.mainPosition,
        sign.user.profile?.mainPosition,
        sign.user.profile?.subPosition,
      ),
      can_substitute: sign.canSubstitute,
      captain_team_ready: Boolean(sign.captainTeamName && sign.captainTeamLogo),
      team_id: sign.teamId,
      team_pos: sign.teamPosition,
      pos_order: sign.positionOrder,
      is_captain: match.captainPosition
        ? sign.mainPosition === match.captainPosition
        : sign.isCaptain,
      fee: rankFee(signRank(sign)),
      ...feeCardDisplay(
        signRank(sign),
        sign.feeCardInventoryId,
        match.status === 'CREATED' && !match.feeCardFirstRoundDone,
      ),
    })),
    current_round: roundNo,
    round_ended: match.roundEnded,
    has_score,
    round_pairs,
    all_round_pairs,
    budget: useFee ? budgetForTeamCount(totalFee, budgetTeams.length) : 0,
    total_fee: totalFee,
    fmvp: fmvpUser
      ? {
          user_id: fmvpUser.id,
          username: fmvpUser.username,
          game_name: fmvpUser.profile?.gameName ?? '',
          avatar: fmvpUser.profile?.avatar ?? '',
        }
      : null,
  };
  const waitlistedSigns = match.signups
    .filter((sign) => sign.isWaitlisted)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  return { board, waitlistedSigns };
}

/** FMVP 只能选本场冠军队的正式成员；校验和保存共用事务，设置后不可更改。 */
export async function setFmvp(matchId: number, userId: number, actorId?: number) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Match" WHERE "id" = ${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match) throw notFound('赛事不存在');
    if (match.status !== 'FINISHED') throw badRequest('赛事结束后才能选择今日 FMVP');
    if (match.fmvpUserId) throw badRequest('今日 FMVP 已设置，不可更改');
    if (!match.championTeamId) throw badRequest('尚未确认冠军队伍，请先完成决赛战果录入并结束赛事');
    const sign = await tx.matchSignup.findFirst({
      where: { matchId, userId, teamId: match.championTeamId, isWaitlisted: false },
      select: { userId: true },
    });
    if (!sign) throw badRequest('只能从本场冠军队伍的参赛选手中选择 FMVP');
    const updated = await tx.match.updateMany({
      where: { id: matchId, status: 'FINISHED', fmvpUserId: null },
      data: { fmvpUserId: userId },
    });
    if (updated.count !== 1) throw badRequest('今日 FMVP 已设置，不可更改');
    // 注意：FMVP 的免ban卡奖励已取消（2026-11），仅保留夺冠奖励渠道。
  });
  return { msg: '今日 FMVP 已设置' };
}

const asInt = (value: string | null, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

/**
 * 管理员视角的用户列表（含审核状态与游戏资料）。
 * 核心管理员（admin 账号）是系统账号，永远不进入用户管理列表；
 * 当前登录的管理员自己也不列进去：自己的账号在这里既管不了、也没必要看。
 * 分页与筛选（关键词 / 审核状态）在服务端完成；pending_total 始终是全局待审核数。
 */
export async function adminUserList(viewerId: number | undefined, query: URLSearchParams) {
  const page = Math.max(0, asInt(query.get('page')));
  const pageSize = Math.min(Math.max(asInt(query.get('pageSize'), 10), 1), 100);
  const keyword = query.get('keyword')?.trim() ?? '';
  const status = query.get('status');
  const role = query.get('role');

  // 普通管理员只能看到并管理普通用户；核心管理员能看到所有账号（含其他管理员）。
  const viewer = viewerId
    ? await prisma.user.findUnique({ where: { id: viewerId }, select: { isCoreAdmin: true } })
    : null;
  const viewerIsCoreAdmin = Boolean(viewer?.isCoreAdmin);

  const baseWhere: Prisma.UserWhereInput = {
    ...(viewerId ? { id: { not: viewerId } } : {}),
    ...(viewerIsCoreAdmin ? {} : { isAdmin: false }),
  };
  const where: Prisma.UserWhereInput = {
    ...baseWhere,
    ...(status && status !== 'ALL' ? { status: status as ReviewStatus } : {}),
    ...(role === 'CORE_ADMIN'
      ? { isCoreAdmin: true }
      : role === 'SECONDARY_ADMIN'
        ? { isAdmin: true, isSecondaryAdmin: true, isCoreAdmin: false }
        : role === 'ADMIN'
          ? { isAdmin: true, isSecondaryAdmin: false, isCoreAdmin: false }
          : role === 'USER'
            ? { isAdmin: false }
            : {}),
  };
  if (keyword) {
    where.OR = [
      { username: { contains: keyword, mode: 'insensitive' } },
      { kookName: { contains: keyword, mode: 'insensitive' } },
      { profile: { is: { gameName: { contains: keyword, mode: 'insensitive' } } } },
    ];
  }

  const [total, pendingTotal, coreAdminTotal, secondaryAdminTotal, adminTotal, users] =
    await Promise.all([
      prisma.user.count({ where }),
      prisma.user.count({ where: { ...baseWhere, status: 'PENDING' } }),
      prisma.user.count({ where: { isCoreAdmin: true } }),
      prisma.user.count({ where: { isAdmin: true, isSecondaryAdmin: true, isCoreAdmin: false } }),
      prisma.user.count({ where: { isAdmin: true, isSecondaryAdmin: false, isCoreAdmin: false } }),
      prisma.user.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: page * pageSize,
        take: pageSize,
        select: {
          id: true,
          username: true,
          isAdmin: true,
          isSecondaryAdmin: true,
          isCoreAdmin: true,
          status: true,
          pendingRank: true,
          kookName: true,
          banUntil: true,
          createdAt: true,
          profile: {
            select: {
              gameName: true,
              rank: true,
              mainPosition: true,
              subPosition: true,
              avatar: true,
            },
          },
        },
      }),
    ]);
  return {
    users,
    total,
    pending_total: pendingTotal,
    core_admin_total: coreAdminTotal,
    secondary_admin_total: secondaryAdminTotal,
    admin_total: adminTotal,
    page,
    pageSize,
    hasMore: (page + 1) * pageSize < total,
  };
}

/**
 * 审核用户。段位是注册时提交、审核通过后锁定的资料：
 * 用户申请修改段位后会在 pendingRank 里挂一笔待审的新值，
 * 只有「通过」才真正写进资料；拒绝或打回则保留原段位。
 * 管理员账号不能被置为非 APPROVED，避免把自己锁在门外；
 * 除核心管理员外，任何人都不能审核其他管理员账号。
 */
export async function setUserStatus(userId: number, status: unknown, actorId: number) {
  if (!REVIEW_STATUSES.includes(status as ReviewStatus)) throw badRequest('审核参数无效');
  await assertCanManageUser(actorId, userId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true, isCoreAdmin: true, username: true, pendingRank: true },
  });
  if (!user) throw notFound('用户不存在');
  const next = status as ReviewStatus;
  if (user.isCoreAdmin) throw new ApiError(403, '不能修改超级vip管理员账号的审核状态');
  if (user.isAdmin && next !== 'APPROVED')
    throw new ApiError(409, '管理员账号不能被拒绝或设为待审核');

  if (next === 'APPROVED' && user.pendingRank) {
    await writeUserRank(userId, user.username, user.pendingRank);
  }
  await prisma.user.update({
    where: { id: userId },
    // 审核结束后清掉待审段位，避免同一次申请被重复应用。
    data: { status: next, pendingRank: '' },
  });
  return { msg: '审核状态已更新', status: next };
}

/**
 * 批量通过审核：把一批待审核账号一次性置为 APPROVED。
 * 先整体校验（存在性、权限、状态、管理员边界），全部通过后再逐个落库，
 * 避免校验到一半就改数据造成「部分成功」的尴尬状态。
 */
export async function batchApproveUsers(userIds: unknown, actorId: number) {
  const ids = Array.isArray(userIds)
    ? Array.from(new Set(userIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)))
    : [];
  if (!ids.length) throw badRequest('请先选择要审核的账号');
  if (ids.length > 100) throw badRequest('单次最多审核 100 个账号');

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      isAdmin: true,
      isCoreAdmin: true,
      username: true,
      status: true,
      pendingRank: true,
    },
  });
  const byId = new Map(users.map((user) => [user.id, user]));
  for (const id of ids) {
    const user = byId.get(id);
    if (!user) throw notFound(`用户 #${id} 不存在`);
    if (user.isCoreAdmin) throw new ApiError(403, '不能修改超级vip管理员账号的审核状态');
    if (user.isAdmin) throw new ApiError(409, `管理员账号 ${user.username} 不需要审核`);
    if (user.status !== 'PENDING')
      throw badRequest(`账号 ${user.username} 不是待审核状态，无法批量通过`);
    await assertCanManageUser(actorId, id);
  }

  for (const id of ids) {
    const user = byId.get(id)!;
    if (user.pendingRank) await writeUserRank(id, user.username, user.pendingRank);
    await prisma.user.update({
      where: { id },
      // 与单个通过一致：审核结束后清掉待审段位。
      data: { status: 'APPROVED', pendingRank: '' },
    });
  }
  return { msg: `已批量通过 ${ids.length} 个账号`, count: ids.length };
}

/** 把段位落到资料上并同步历史报名快照；「未定段」统一折算成空串。 */
async function writeUserRank(userId: number, username: string, rank: string) {
  const stored = normalizeRank(rank);
  await prisma.$transaction([
    prisma.playerProfile.upsert({
      where: { userId },
      update: { rank: stored },
      create: { userId, name: username, gameName: '', rank: stored, avatar: randomDefaultAvatar() },
    }),
    prisma.matchSignup.updateMany({ where: { userId }, data: { rankAtSignup: stored } }),
  ]);
  return stored;
}

/** 管理员直接改段位（二级管理员及以上）：同时清掉待审的段位申请，避免旧申请被重复应用。 */
export async function setUserRank(userId: number, rank: string, actorId: number) {
  if (!RANKS.includes(rank)) throw badRequest('段位不合法');
  await assertSecondaryAdmin(actorId, '只有二级管理员及以上可以重置段位');
  await assertCanManageUser(actorId, userId);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw badRequest('用户不存在');

  const stored = await writeUserRank(userId, user.username, rank);
  await prisma.user.update({
    where: { id: userId },
    data: { pendingRank: '' },
  });
  return { msg: `已将 ${user.username} 段位改为「${stored || '未设置'}」` };
}

export async function setUserGameName(userId: number, gameName: string, actorId: number) {
  await assertCanManageUser(actorId, userId);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw badRequest('用户不存在');
  // 允许清空（留空表示还未填写），但填了就必须符合 名称#数字编号 的格式。
  const value = gameName.trim();
  if (value && !isValidGameName(value)) throw badRequest(`游戏ID格式不正确：${GAME_NAME_HINT}`);
  if (value) {
    // 昵称可重复、数字编号也可重复，但「昵称#编号」整体必须全局唯一：
    // 先按完整游戏ID查重，再兜底数据库唯一索引的并发冲突。
    const existing = await prisma.playerProfile.findFirst({
      where: { gameName: { equals: value, mode: 'insensitive' }, userId: { not: userId } },
      select: { userId: true },
    });
    if (existing) throw badRequest('该游戏ID已被其他选手使用');
  }
  try {
    await prisma.playerProfile.upsert({
      where: { userId },
      update: { gameName: value },
      create: { userId, name: user.username, gameName: value, avatar: randomDefaultAvatar() },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw badRequest('该游戏ID已被其他选手使用');
    }
    throw error;
  }
  return { msg: `已设置 ${user.username} 的游戏ID：${value || '(空)'}` };
}

/**
 * 重置用户密码（仅核心管理员可用）：统一重置为固定密码 lxl123456，
 * 普通管理员一律无权限，且不能重置自己的密码。
 */
export async function resetUserPassword(userId: number, actorId: number) {
  if (!(await isCoreAdminActor(actorId))) throw forbidden('只有超级vip管理员才能重置密码');
  if (userId === actorId) throw badRequest('不能重置自己的密码');
  const target = await assertCanManageUser(actorId, userId);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(RESET_PASSWORD, 12) },
  });
  return { msg: `已将 ${target.username} 的密码重置为 ${RESET_PASSWORD}` };
}

/**
 * 调整账号角色：只有核心管理员能操作，且不能改自己
 * （核心管理员一旦取消自己的权限就再也无法恢复，只能改数据库）。
 *
 * role 取值：
 * - "CORE_ADMIN"：核心管理员（isAdmin + isCoreAdmin，可操作后台任意按钮）
 * - "SECONDARY_ADMIN"：二级管理员（isAdmin + isSecondaryAdmin，额外可重置段位 / 处罚 / 取消报名）
 * - "ADMIN"：普通管理员（isAdmin，受限操作）
 * - "USER"：普通用户（取消管理员）
 */
export async function setUserRole(
  userId: number,
  role: 'CORE_ADMIN' | 'SECONDARY_ADMIN' | 'ADMIN' | 'USER',
  actorId: number,
) {
  if (!['CORE_ADMIN', 'SECONDARY_ADMIN', 'ADMIN', 'USER'].includes(role))
    throw badRequest('角色参数无效');
  if (!(await isCoreAdminActor(actorId))) throw forbidden('只有超级vip管理员可以调整管理员权限');
  if (userId === actorId) throw badRequest('不能修改自己的管理员权限');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw badRequest('用户不存在');
  const data =
    role === 'CORE_ADMIN'
      ? { isAdmin: true, isSecondaryAdmin: false, isCoreAdmin: true }
      : role === 'SECONDARY_ADMIN'
        ? { isAdmin: true, isSecondaryAdmin: true, isCoreAdmin: false }
        : role === 'ADMIN'
          ? { isAdmin: true, isSecondaryAdmin: false, isCoreAdmin: false }
          : { isAdmin: false, isSecondaryAdmin: false, isCoreAdmin: false };
  await prisma.user.update({ where: { id: userId }, data });
  const label =
    role === 'CORE_ADMIN'
      ? '设为核心管理员'
      : role === 'SECONDARY_ADMIN'
        ? '设为二级管理员'
        : role === 'ADMIN'
          ? '设为普通管理员'
          : '取消管理员';
  return { msg: `已将 ${user.username} ${label}` };
}

/**
 * 处罚用户（二级管理员及以上）：限制其报名（banUntil 之前禁止报名）。
 * 管理员账号只有核心管理员能处罚，核心管理员账号本身不可被处罚。
 */
export async function banUser(userId: number, days: number, actorId: number) {
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw badRequest('处罚天数需为 1-3650 之间的整数');
  await assertSecondaryAdmin(actorId, '只有二级管理员及以上可以处罚用户');
  const target = await assertCanManageUser(actorId, userId);
  if (target.isCoreAdmin) throw forbidden('不能处罚超级vip管理员账号');
  // 已报名未结束赛事的用户不能处罚：先取消报名（或等赛事结束）再处罚。
  const activeSignups = await prisma.matchSignup.findMany({
    where: { userId, match: { status: { in: ['CREATED', 'LIVE'] } } },
    select: { match: { select: { name: true } } },
  });
  if (activeSignups.length) {
    const names = activeSignups.map((sign) => sign.match.name);
    const shown =
      names.length > 3
        ? `${names.slice(0, 3).join('、')} 等 ${names.length} 个赛事`
        : names.join('、');
    throw badRequest(`该用户已报名「${shown}」，暂时不能处罚`);
  }
  const banUntil = new Date(Date.now() + days * 86400000);
  await prisma.user.update({ where: { id: userId }, data: { banUntil } });
  return { msg: `已处罚 ${target.username}，${days} 天内禁止报名` };
}

/** 解除处罚（二级管理员及以上）：立即恢复报名资格。 */
export async function unbanUser(userId: number, actorId: number) {
  await assertSecondaryAdmin(actorId, '只有二级管理员及以上可以解除处罚');
  const target = await assertCanManageUser(actorId, userId);
  await prisma.user.update({ where: { id: userId }, data: { banUntil: null } });
  return { msg: `已解除 ${target.username} 的处罚` };
}

/**
 * 删除用户：先清报名并同步各赛事人数，再删账号（资料/战绩随外键级联删除）。
 * 管理员账号只有核心管理员能删。
 */
export async function deleteUser(userId: number, currentUserId: number) {
  // 删除用户是高风险操作：只有核心管理员能删，普通管理员一律拒绝。
  if (!(await isCoreAdminActor(currentUserId))) {
    throw forbidden('只有超级vip管理员才能删除用户');
  }
  if (userId === currentUserId) throw badRequest('不能删除当前登录的管理员账号');
  await assertCanManageUser(currentUserId, userId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, isCoreAdmin: true },
  });
  if (!user) throw badRequest('用户不存在');
  if (user.isCoreAdmin) throw new ApiError(403, '不能删除超级vip管理员账号');

  const signups = await prisma.matchSignup.findMany({ where: { userId } });
  await prisma.$transaction(async (tx) => {
    for (const signup of signups) {
      await tx.match.update({
        where: { id: signup.matchId },
        data: { playerCount: { decrement: 1 } },
      });
    }
    await tx.matchSignup.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } });
  });
  return { msg: '用户删除成功' };
}

export async function cancelSignup(signupId: number, actorId: number) {
  // 与「报名记录」面板一致：二级管理员及以上可以取消报名。
  await assertSecondaryAdmin(actorId, '只有二级管理员及以上可以取消报名');
  const signup = await prisma.matchSignup.findUnique({ where: { id: signupId } });
  if (!signup) throw notFound('报名记录不存在');
  await removeSignupAndPromote(signupId);
  return { msg: '已取消该选手报名' };
}

/** 后台调整某条报名的分路，省去「取消报名再重新报名」。 */
export async function changeSignupPosition(signupId: number, mainPosition: unknown) {
  const signup = await prisma.matchSignup.findUnique({
    where: { id: signupId },
    include: { match: { select: { id: true, bo: true, status: true, captainPosition: true } } },
  });
  if (!signup) throw notFound('报名记录不存在');
  if (signup.match.status !== 'CREATED') throw badRequest('赛事已开始，不能调整报名位置');
  assertSignupPayload(mainPosition);
  const target = String(mainPosition);
  if (target === signup.mainPosition) return { msg: '报名位置未变化' };
  if (signup.feeCardInventoryId && target !== signup.match.captainPosition)
    throw badRequest('该报名已使用降费卡，不能改为非队长分路；取消报名不会退卡');
  if (signup.teamId && signup.match.captainPosition)
    throw badRequest('已入队选手请先移回待选池，再修改报名分路');
  // 换位置会改变各分路的名额占用，必须重排正式/候补：
  // 腾出来的分路由最早报名的候补自动递补；换进已满的分路则按报名时间排到队尾，可能自己变成候补。
  const { promoted, demoted } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${signup.matchId} FOR UPDATE`;
    if (target !== signup.match.captainPosition && signup.captainTeamName)
      await releaseCaptainTeam(tx, signup.id);
    await tx.matchSignup.update({
      where: { id: signupId },
      data: {
        mainPosition: target,
        ...(target !== signup.match.captainPosition
          ? { captainTeamName: '', captainTeamLogo: '' }
          : {}),
        ...(signup.match.captainPosition
          ? { isCaptain: target === signup.match.captainPosition && !signup.isWaitlisted }
          : {}),
      },
    });
    return rebalanceSignupWaitlist(signup.match.id, tx);
  });
  if (target !== signup.match.captainPosition) await cleanupCaptainLogo(signup.captainTeamLogo);
  const suffix = promoted || demoted ? `（${promoted} 人递补为正式，${demoted} 人进入候补）` : '';
  return { msg: `报名位置已改为${positionText(target)}${suffix}` };
}

/**
 * 后台「报名记录」Tab：待选人赛事的常规赛报名 + 报名中（待选人）战队赛的报名。
 * `source` 区分两种报名，客户端据此调用对应的取消/换位置接口。
 */
export async function signupList() {
  const [signups, seasonSignups] = await Promise.all([
    prisma.matchSignup.findMany({
      where: { match: { status: 'CREATED' } },
      orderBy: [{ matchId: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: {
        user: {
          select: { id: true, username: true, profile: { select: { gameName: true, rank: true } } },
        },
        match: {
          select: { id: true, name: true, captainPosition: true, feeCardFirstRoundDone: true },
        },
      },
    }),
    prisma.teamSeasonSignup.findMany({
      where: { season: { status: 'DRAFTING' } },
      orderBy: [{ seasonId: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: {
        user: {
          select: { id: true, username: true, profile: { select: { gameName: true, rank: true } } },
        },
        season: {
          select: {
            id: true,
            name: true,
            teams: { select: { members: { select: { userId: true, role: true } } } },
          },
        },
      },
    }),
  ]);

  return {
    signup_list: [
      ...signups.map((signup) => ({
        sign_id: signup.id,
        source: 'match',
        event_id: signup.matchId,
        event_name: signup.match.name,
        user_id: signup.userId,
        username: signup.user.username,
        game_name: signup.user.profile?.gameName ?? '',
        rank: signup.user.profile?.rank ?? '',
        is_captain:
          !signup.isWaitlisted &&
          (signup.match.captainPosition
            ? signup.mainPosition === signup.match.captainPosition
            : signup.isCaptain),
        ...feeCardDisplay(
          signup.user.profile?.rank || signup.rankAtSignup,
          signup.feeCardInventoryId,
          !signup.isWaitlisted && !signup.match.feeCardFirstRoundDone,
        ),
        yy_name: signup.displayName,
        main_pos: signup.mainPosition,
        team_role: '',
        // 正式 / 候补：名额按赛制与报名先后排定，换位置后可能变化。
        is_waitlisted: signup.isWaitlisted,
      })),
      ...seasonSignups.map((signup) => {
        const role = signup.season.teams
          .flatMap((team) => team.members)
          .find((member) => member.userId === signup.userId)?.role;
        return {
          sign_id: signup.id,
          source: 'season',
          event_id: signup.seasonId,
          event_name: signup.season.name,
          user_id: signup.userId,
          username: signup.user.username,
          game_name: signup.user.profile?.gameName ?? '',
          rank: signup.user.profile?.rank ?? '',
          // 战队赛报名没有语音名，只能展示「未填写」以外的占位。
          yy_name: '',
          main_pos: signup.mainPosition,
          team_role: role ?? '',
          // 战队赛按首发/替补分角色，没有常规赛那套分路名额候补。
          is_waitlisted: false,
        };
      }),
    ],
  };
}

/** 报名时的字段校验。 */
export function assertSignupPayload(mainPosition: unknown) {
  if (!isPosition(mainPosition)) throw new ApiError(400, '分路不合法');
}
