import { Prisma, type Match as DbMatch } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { feeCardDisplay } from '@/lib/fee-reduction';
import { badRequest } from '@/server/api';
import { isPresetTeamLogo, validateCaptainTeam } from '@/lib/captain-teams';
import {
  assertUniqueCaptainName,
  cleanupCaptainLogo,
  releaseCaptainTeam,
  syncCaptainTeams,
} from '@/server/captain-teams';
import { activeNameplatesForUsers } from '@/server/nameplates';
import type { Match, Player } from '@/lib/data';
import { POSITION_OPTIONS, matchTeamLimit, meetsSignupRank } from '@/lib/admin-options';
import {
  activeTitleMap,
  listPlayerCards,
  playerCardByUserId,
  toPlayer,
  type PlayerListQuery,
} from '@/server/records';

type MatchWithCreator = DbMatch & {
  createdBy?: {
    username: string;
    profile?: { gameName: string; name: string } | null;
  } | null;
};

export function matchFrom(match: MatchWithCreator, signed = false): Match {
  return {
    id: match.id,
    name: match.name,
    createdAt: match.createdAt.toISOString(),
    createdByName:
      match.createdBy?.profile?.gameName?.trim() ||
      match.createdBy?.profile?.name?.trim() ||
      match.createdBy?.username ||
      '',
    date: match.date?.toISOString() ?? null,
    status: match.status,
    statusLocked: match.statusLocked,
    bo: match.bo,
    customTeamCount: match.customTeamCount,
    roundFormats: match.roundFormats,
    minSignupRank: match.minSignupRank,
    allowItemCards: match.allowItemCards,
    playerCount: match.playerCount,
    teamCount: match.teamCount,
    signed,
    round: match.round,
    liveUrl: match.liveUrl,
    useFee: match.useFee,
    captainPosition: match.captainPosition,
    currentRound: match.currentRound,
    importTarget: match.importTarget,
    teamOneId: match.teamOneId,
    teamTwoId: match.teamTwoId,
    prizePoolJson: match.prizePoolJson,
    prizeDistributed: match.prizeDistributed,
  };
}

export async function getPlayers(query?: PlayerListQuery): Promise<Player[]> {
  return listPlayerCards(query);
}

export async function getMatches(userId?: number) {
  const [matches, signups] = await Promise.all([
    prisma.match.findMany({
      orderBy: { date: 'asc' },
      include: {
        createdBy: {
          select: {
            username: true,
            profile: { select: { gameName: true, name: true } },
          },
        },
      },
    }),
    userId ? prisma.matchSignup.findMany({ where: { userId }, select: { matchId: true } }) : [],
  ]);
  const signedMatchIds = new Set(signups.map((signup) => signup.matchId));
  return matches.map((match) => matchFrom(match, signedMatchIds.has(match.id)));
}

export async function getMatchById(id: number) {
  if (!Number.isInteger(id) || id < 1) return null;
  const match = await prisma.match.findUnique({ where: { id } });
  return match ? matchFrom(match) : null;
}

/** 参赛名单：以报名记录为准（含队伍与位置槽），统计取该选手的战绩聚合。
    所有账号均可参赛，不再区分核心管理员。 */
export async function getMatchPlayers(matchId: number) {
  const [signups, records] = await Promise.all([
    prisma.matchSignup.findMany({
      where: { matchId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        match: { select: { captainPosition: true, feeCardFirstRoundDone: true, status: true } },
        user: {
          include: {
            profile: {
              include: {
                user: {
                  select: {
                    username: true,
                    kookName: true,
                    backgroundImage: true,
                    avatarFrame: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.matchGameRecord.findMany({
      where: { matchId },
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
    }),
  ]);

  const byUser = new Map<number, typeof records>();
  for (const record of records) {
    const bucket = byUser.get(record.userId) ?? [];
    bucket.push(record);
    byUser.set(record.userId, bucket);
  }

  const nameplates = await activeNameplatesForUsers(signups.map((signup) => signup.user));
  const players = signups.flatMap((signup) => {
    const profile = signup.user.profile;
    if (!profile) return [];
    return [
      {
        ...toPlayer(profile, byUser.get(signup.userId) ?? []),
        nameplate: nameplates.get(signup.userId) ?? '',
        // 名单以报名时选择的位置为准，覆盖个人资料里的默认位置。
        position: signup.mainPosition,
        profileMainPosition: profile.mainPosition,
        profileSubPosition: profile.subPosition,
        mainPosition: signup.mainPosition,
        subPosition: signup.subPosition,
        signupId: signup.id,
        teamId: signup.teamId,
        teamPosition: signup.teamPosition,
        positionOrder: signup.positionOrder,
        canSubstitute: signup.canSubstitute,
        isWaitlisted: signup.isWaitlisted,
        declaration: signup.declaration,
        isCaptain:
          !signup.isWaitlisted &&
          (signup.match.captainPosition
            ? signup.mainPosition === signup.match.captainPosition
            : signup.isCaptain),
        ...feeCardDisplay(
          profile.rank || signup.rankAtSignup,
          signup.feeCardInventoryId,
          !signup.isWaitlisted &&
            signup.match.status === 'CREATED' &&
            !signup.match.feeCardFirstRoundDone,
        ),
      },
    ];
  });

  // 报名名单 / 对战表也要带出当前生效称号，统一徽章展示。
  const titleMap = await activeTitleMap(players.map((player) => player.id));
  for (const player of players) player.title = titleMap.get(player.id) ?? '';

  return players;
}

export async function getProfileForUser(userId: number) {
  return playerCardByUserId(userId);
}

/** 报名时选择的分路（沿用旧报名弹窗契约的 main_pos），以及参赛宣言。 */
export type SignupOptions = {
  teamName?: string;
  teamLogo?: string;
  logoFile?: unknown;
  uploadedLogo?: boolean;
  mainPosition?: string;
  declaration?: string;
  waitlistConfirmed?: boolean;
  useFeeCard?: boolean;
};

export async function signupForMatch(matchId: number, userId: number, options: SignupOptions = {}) {
  const [profile, user] = await Promise.all([
    prisma.playerProfile.findUnique({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { username: true } }),
  ]);
  const position = options.mainPosition ?? profile?.mainPosition ?? 'FILL';
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
        const match = await tx.match.findUnique({ where: { id: matchId } });
        if (!match) return { kind: 'not_found' as const };
        if (match.status !== 'CREATED') return { kind: 'closed' as const };
        const existingSignup = await tx.matchSignup.findUnique({
          where: { userId_matchId: { userId, matchId } },
          select: { id: true },
        });
        if (existingSignup) return { kind: 'exists' as const };
        if (match.minSignupRank && !meetsSignupRank(profile?.rank, match.minSignupRank)) {
          throw badRequest('报名要求 ' + match.minSignupRank + ' 及以上段位');
        }
        if (options.useFeeCard) {
          throw badRequest(
            match.allowItemCards === false
              ? '本场赛事禁止使用道具卡'
              : '请先报名，再点击赛事页面的使用降费卡按钮',
          );
        }
        const previousUse = await tx.matchFeeCardUse.findUnique({
          where: { userId_matchId: { userId, matchId } },
        });
        const feeCardInventoryId =
          previousUse && (!match.captainPosition || position === match.captainPosition)
            ? previousUse.inventoryId
            : null;
        const isCaptain = Boolean(match.captainPosition && position === match.captainPosition);
        const teamName = options.teamName?.trim() ?? '';
        const teamLogo = options.teamLogo ?? '';
        if (isCaptain) {
          const invalid = validateCaptainTeam(teamName, teamLogo);
          if (invalid) throw badRequest(invalid);
          if (!isPresetTeamLogo(teamLogo) && !options.uploadedLogo) throw badRequest('队标无效');
          await assertUniqueCaptainName(tx, matchId, teamName);
        }
        const positionLimit = matchTeamLimit(match.bo, match.customTeamCount);
        const positionSignupCount = positionLimit
          ? await tx.matchSignup.count({
              where: {
                matchId,
                isWaitlisted: false,
                OR: [{ teamPosition: position }, { teamPosition: '', mainPosition: position }],
              },
            })
          : 0;
        const totalLimit = positionLimit ? positionLimit * POSITION_OPTIONS.length : null;
        const formalSignupCount = totalLimit
          ? await tx.matchSignup.count({ where: { matchId, isWaitlisted: false } })
          : 0;
        const isPositionFull = Boolean(positionLimit && positionSignupCount >= positionLimit);
        const isRosterFull = Boolean(totalLimit && formalSignupCount >= totalLimit);
        if ((isPositionFull || isRosterFull) && !options.waitlistConfirmed) {
          return { kind: 'waitlist_confirmation_required' as const };
        }
        const isWaitlisted = isPositionFull || isRosterFull;
        await tx.matchSignup.create({
          data: {
            matchId,
            userId,
            displayName: profile?.name || user?.username || '',
            mainPosition: position,
            subPosition: '',
            rankAtSignup: profile?.rank ?? '',
            canSubstitute: false,
            isWaitlisted,
            declaration: options.declaration ?? '',
            isCaptain: isCaptain && !isWaitlisted,
            captainTeamName: isCaptain ? teamName : '',
            captainTeamLogo: isCaptain ? teamLogo : '',
            feeCardInventoryId,
          },
        });
        await tx.match.update({ where: { id: matchId }, data: { playerCount: { increment: 1 } } });
        if (isCaptain && !isWaitlisted) await syncCaptainTeams(tx, matchId);
        return { kind: 'ok' as const, isWaitlisted };
      },
      { isolationLevel: 'Serializable' },
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return { kind: 'exists' as const };
    throw error;
  }
}

export async function removeSignupAndPromote(signupId: number) {
  const original = await prisma.matchSignup.findUnique({ where: { id: signupId } });
  if (!original) return false;
  let removedLogo = original.captainTeamLogo;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${original.matchId} FOR UPDATE`;
    const signup = await tx.matchSignup.findUnique({ where: { id: signupId } });
    if (!signup) return;
    removedLogo = signup.captainTeamLogo;
    const match = await tx.match.findUnique({
      where: { id: signup.matchId },
      select: { status: true, captainPosition: true },
    });
    if (match?.status === 'CREATED') {
      await tx.matchHeroProtection.deleteMany({
        where: { matchId: signup.matchId, ownerId: signup.userId, card: { consumedAt: null } },
      });
    }
    await releaseCaptainTeam(tx, signupId);
    await tx.matchSignup.delete({ where: { id: signupId } });
    if (!signup.isWaitlisted && match?.status === 'CREATED') {
      const vacatedPosition = signup.teamPosition || signup.mainPosition;
      const next = await tx.matchSignup.findFirst({
        where: { matchId: signup.matchId, mainPosition: vacatedPosition, isWaitlisted: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (next) {
        await tx.matchSignup.update({
          where: { id: next.id },
          data: {
            isWaitlisted: false,
            waitlistOrigin: false,
            teamId: null,
            teamPosition: '',
            positionOrder: 0,
            isCaptain: Boolean(
              match.captainPosition && next.mainPosition === match.captainPosition,
            ),
          },
        });
      }
    }
    await tx.match.update({
      where: { id: signup.matchId },
      data: { playerCount: { decrement: 1 } },
    });
    await syncCaptainTeams(tx, signup.matchId);
  });
  await cleanupCaptainLogo(removedLogo);
  return true;
}

export async function cancelSignupForMatch(matchId: number, userId: number) {
  const signup = await prisma.matchSignup.findUnique({
    where: { userId_matchId: { userId, matchId } },
  });
  if (!signup) return { kind: 'not_found' as const };
  await removeSignupAndPromote(signup.id);
  return { kind: 'ok' as const };
}

/**
 * 依据赛制名额重排正式/候补：每个报名位置按报名时间先后取满名额，
 * 超出的选手自动进入候补；名额放宽（例如 BO3 切六队）时，候补按报名顺序自动递补为正式。
 * BO1 不限制名额（positionLimit 为 null），全部转为正式。
 */
export async function rebalanceSignupWaitlist(
  matchId: number,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const match = await db.match.findUniqueOrThrow({
    where: { id: matchId },
    select: { captainPosition: true, bo: true, customTeamCount: true },
  });
  const positionLimit = matchTeamLimit(match.bo, match.customTeamCount);

  const signups = await db.matchSignup.findMany({
    where: { matchId },
    select: {
      id: true,
      mainPosition: true,
      teamId: true,
      isWaitlisted: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  // 按报名位置分组；整体已按报名时间升序，分组后各组仍保持该顺序。
  const byPosition = new Map<string, typeof signups>();
  for (const signup of signups) {
    const position = signup.mainPosition || 'FILL';
    const bucket = byPosition.get(position) ?? [];
    bucket.push(signup);
    byPosition.set(position, bucket);
  }

  const formalIds = new Set<number>();
  for (const bucket of byPosition.values()) {
    const keep = positionLimit === null ? bucket.length : Math.min(positionLimit, bucket.length);
    for (let index = 0; index < keep; index++) formalIds.add(bucket[index].id);
  }

  let promoted = 0;
  let demoted = 0;
  for (const signup of signups) {
    const shouldBeFormal = formalIds.has(signup.id);
    if (shouldBeFormal && !signup.isWaitlisted) continue;
    // 已在候补且未入队的选手无需变更。
    if (!shouldBeFormal && signup.isWaitlisted && signup.teamId === null) continue;
    if (shouldBeFormal) {
      promoted++;
      await db.matchSignup.update({
        where: { id: signup.id },
        data: {
          isWaitlisted: false,
          waitlistOrigin: false,
          ...(match.captainPosition
            ? { isCaptain: signup.mainPosition === match.captainPosition }
            : {}),
        },
      });
    } else {
      demoted++;
      await releaseCaptainTeam(db, signup.id);
      await db.matchSignup.update({
        where: { id: signup.id },
        data: {
          isWaitlisted: true,
          waitlistOrigin: true,
          teamId: null,
          teamPosition: '',
          positionOrder: 0,
          isCaptain: false,
        },
      });
    }
  }

  await syncCaptainTeams(db, matchId);
  return { promoted, demoted };
}
