import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { feeCardDisplay } from '@/lib/fee-reduction';
import type { MatchRegistrationSnapshot } from '@/lib/match-registration';
import { getSessionUser } from '@/server/auth';
import { notFound, requiredId, unauthorized, withApiErrors } from '@/server/api';
import { activeNameplatesForUsers } from '@/server/nameplates';

/** A narrow read: no match history, rankings, bracket or player statistics. */
export async function getMatchRegistrationSnapshot(id: number): Promise<MatchRegistrationSnapshot> {
  const match = await prisma.match.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      playerCount: true,
      captainPosition: true,
      feeCardFirstRoundDone: true,
      signups: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          userId: true,
          mainPosition: true,
          teamPosition: true,
          isWaitlisted: true,
          isCaptain: true,
          declaration: true,
          rankAtSignup: true,
          feeCardInventoryId: true,
          user: {
            select: {
              username: true,
              title: true,
              avatarFrame: true,
              nameplateInventoryId: true,
              profile: {
                select: {
                  name: true,
                  gameName: true,
                  rank: true,
                  avatar: true,
                  mainPosition: true,
                  subPosition: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!match) throw notFound('赛事不存在');
  const nameplates = await activeNameplatesForUsers(
    match.signups.map((signup) => ({
      id: signup.userId,
      nameplateInventoryId: signup.user.nameplateInventoryId,
    })),
  );
  return {
    matchId: match.id,
    status: match.status,
    playerCount: match.playerCount,
    players: match.signups.flatMap((signup) => {
      const profile = signup.user.profile;
      if (!profile) return [];
      return [
        {
          id: signup.userId,
          name: profile.name || signup.user.username,
          gameName: profile.gameName,
          title: signup.user.title,
          position: signup.mainPosition,
          profileMainPosition: profile.mainPosition,
          profileSubPosition: profile.subPosition,
          teamPosition: signup.teamPosition,
          rank: profile.rank,
          avatar: profile.avatar,
          avatarFrame: signup.user.avatarFrame,
          nameplate: nameplates.get(signup.userId) ?? '',
          isWaitlisted: signup.isWaitlisted,
          isCaptain:
            !signup.isWaitlisted &&
            (match.captainPosition
              ? signup.mainPosition === match.captainPosition
              : signup.isCaptain),
          declaration: signup.declaration,
          ...feeCardDisplay(
            profile.rank || signup.rankAtSignup,
            signup.feeCardInventoryId,
            !signup.isWaitlisted && match.status === 'CREATED' && !match.feeCardFirstRoundDone,
          ),
        },
      ];
    }),
  };
}

export function registrationResponse(request: NextRequest, snapshot: MatchRegistrationSnapshot) {
  const body = JSON.stringify(snapshot);
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  const headers = {
    'Cache-Control': 'private, no-store',
    ETag: etag,
    Vary: 'Cookie, Authorization',
  };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function getMatchRegistration(request: NextRequest, rawId: string) {
  return withApiErrors(async () => {
    if (!(await getSessionUser(request))) throw unauthorized();
    const snapshot = await getMatchRegistrationSnapshot(requiredId(rawId));
    return registrationResponse(request, snapshot);
  });
}
