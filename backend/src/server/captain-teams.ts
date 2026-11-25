import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  CAPTAIN_TEAM_PRESETS,
  isPresetTeamLogo,
  MAX_TEAM_LOGO_BYTES,
  validateCaptainTeam,
  type CurrentMatchTeam,
} from '@/lib/captain-teams';
import { teamLogo } from '@/lib/teams';
import {
  EIGHT_TEAM_FORMAT,
  EIGHT_TEAM_FORMAT_V2,
  SIX_TEAM_FORMAT,
  SIX_TEAM_FORMAT_V2,
} from '@/lib/admin-options';
import { badRequest, forbidden, notFound } from '@/server/api';
import { readUpload } from '@/server/account';
import { deleteStoredObject, putUploadedImage } from '@/server/uploads';
import { reorderDraftAfterCompletedRound } from '@/server/roster';

/** Empty legacy presets are not participating teams once a captain lane is configured. */
export const activeMatchTeamWhere = (matchId: number): Prisma.TeamWhereInput => ({
  matchId,
  OR: [
    { match: { captainPosition: '' } },
    { captainSignupId: { not: null } },
    { signups: { some: {} } },
  ],
});

export async function captainRequestBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    const form = await request.formData();
    const body = Object.fromEntries(form.entries()) as Record<string, unknown>;
    for (const key of ['waitlist_confirmed', 'use_fee_card']) {
      if (body[key] === 'true' || body[key] === 'false') body[key] = body[key] === 'true';
    }
    return body;
  }
  return request.json().catch(() => ({}));
}

export async function prepareCaptainLogo(
  matchId: number,
  userId: number,
  logo: string,
  file?: unknown,
  previous = '',
) {
  if (file instanceof File && file.size) {
    const upload = await readUpload(file, MAX_TEAM_LOGO_BYTES, { allowSvg: true });
    if (!upload.ok) throw badRequest(upload.error);
    const name = `m${matchId}_u${userId}_${randomUUID()}${upload.ext}`;
    const mime: Record<string, string> = {
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    };
    await putUploadedImage('team-logos', name, upload.buffer, mime[upload.ext]);
    return { logo: `/assets/team-logos/${name}`, uploaded: true };
  }
  if (!isPresetTeamLogo(logo) && (!previous || logo !== previous))
    throw badRequest('请选择有效队标或上传图片');
  return { logo, uploaded: false };
}

export async function cleanupCaptainLogo(logo: string) {
  const name = /^\/assets\/team-logos\/(m\d+_u\d+_[\w-]+\.(?:png|jpe?g|webp|gif|svg))$/i.exec(
    logo,
  )?.[1];
  if (!name) return;
  const [sign, team] = await Promise.all([
    prisma.matchSignup.count({ where: { captainTeamLogo: logo } }),
    prisma.team.count({ where: { logo } }),
  ]);
  if (!sign && !team) await deleteStoredObject('team-logos', name);
}

export async function assertCaptainTeamsEditable(tx: Prisma.TransactionClient, matchId: number) {
  const match = await tx.match.findUniqueOrThrow({ where: { id: matchId } });
  if (
    match.status !== 'CREATED' ||
    (await tx.matchSignup.count({
      where: {
        matchId,
        teamId: { not: null },
        ...(match.captainPosition
          ? { mainPosition: { not: match.captainPosition } }
          : { isCaptain: false }),
      },
    })) ||
    (await tx.matchScore.count({ where: { matchId } })) ||
    (await tx.matchGameRecord.count({ where: { matchId } }))
  ) {
    throw badRequest('已开始选人或比赛，队伍设置已锁定');
  }
  return match;
}

export async function assertCaptainTeamsReady(tx: Prisma.TransactionClient, matchId: number) {
  const match = await tx.match.findUniqueOrThrow({ where: { id: matchId } });
  if (!match.captainPosition) return;
  // Preserve already-running drafts created before this feature was deployed.
  if (
    await tx.matchSignup.count({
      where: { matchId, teamId: { not: null }, mainPosition: { not: match.captainPosition } },
    })
  )
    return;
  const captains = await tx.matchSignup.findMany({
    where: { matchId, isWaitlisted: false, mainPosition: match.captainPosition },
  });
  const limit =
    match.bo === 'BO5'
      ? 2
      : match.bo === 'BO3'
        ? 4
        : [SIX_TEAM_FORMAT, SIX_TEAM_FORMAT_V2].includes(match.bo)
          ? 6
          : [EIGHT_TEAM_FORMAT, EIGHT_TEAM_FORMAT_V2].includes(match.bo)
            ? 8
            : 2;
  if (
    captains.length < limit ||
    captains.some((sign) => !sign.captainTeamName || !sign.captainTeamLogo)
  )
    throw badRequest('请等待本场队长报名并完成队伍设置');
}

/** Materialize only configured formal captains; old signups remain untouched until settings are saved. */
export async function syncCaptainTeams(tx: Prisma.TransactionClient, matchId: number) {
  const match = await tx.match.findUniqueOrThrow({ where: { id: matchId } });
  if (match.status !== 'CREATED') return;
  const signs = await tx.matchSignup.findMany({
    where: {
      matchId,
      ...(match.captainPosition ? { mainPosition: match.captainPosition } : { isCaptain: true }),
      isWaitlisted: false,
      captainTeamName: { not: '' },
      captainTeamLogo: { not: '' },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!match.captainPosition && !signs.length) return;
  let seatingChanged = false;
  for (const sign of signs) {
    const owned = await tx.team.findUnique({ where: { captainSignupId: sign.id } });
    const existing =
      owned ??
      (sign.teamId
        ? await tx.team.findUnique({ where: { id: sign.teamId } })
        : await tx.team.findFirst({
            where: {
              matchId,
              name: { equals: sign.captainTeamName, mode: 'insensitive' },
              captainSignupId: null,
              signups: { none: {} },
            },
          }));
    const duplicate = await tx.team.findFirst({
      where: {
        matchId,
        name: { equals: sign.captainTeamName, mode: 'insensitive' },
        ...(existing ? { id: { not: existing.id } } : {}),
      },
    });
    if (duplicate) throw badRequest('本场已有同名队伍，请更换队名');
    if (existing?.captainSignupId && existing.captainSignupId !== sign.id)
      throw badRequest('队伍已有其他队长');
    const max = await tx.team.aggregate({
      where: { matchId },
      _max: { sortOrder: true, draftOrder: true },
    });
    const data = {
      name: sign.captainTeamName,
      logo: sign.captainTeamLogo,
      captainSignupId: sign.id,
    };
    const team = existing
      ? await tx.team.update({ where: { id: existing.id }, data })
      : await tx.team.create({
          data: {
            ...data,
            matchId,
            sortOrder: (max._max.sortOrder ?? 0) + 1,
            draftOrder: (max._max.draftOrder ?? 0) + 1,
          },
        });
    if (
      sign.teamId !== team.id ||
      (match.captainPosition && (sign.teamPosition !== sign.mainPosition || !sign.isCaptain))
    ) {
      seatingChanged = true;
      await tx.matchSignup.update({
        where: { id: sign.id },
        data: {
          teamId: team.id,
          teamPosition: sign.mainPosition,
          positionOrder: 1,
          isCaptain: true,
        },
      });
    }
  }
  if (seatingChanged && match.captainPosition) {
    let ready = true;
    try {
      await assertCaptainTeamsReady(tx, matchId);
    } catch {
      ready = false;
    }
    if (ready) await reorderDraftAfterCompletedRound(matchId, tx);
  }
  await tx.match.update({
    where: { id: matchId },
    data: {
      teamCount: await tx.team.count({
        where: activeMatchTeamWhere(matchId),
      }),
    },
  });
}

export async function defaultCaptainTeam(matchId: number) {
  const signs = await prisma.matchSignup.findMany({
    where: { matchId },
    select: { captainTeamName: true },
  });
  const assigned = await prisma.team.findMany({
    where: { matchId, signups: { some: {} } },
    select: { name: true },
  });
  const used = new Set(signs.map((sign) => sign.captainTeamName.toUpperCase()));
  for (const team of assigned) used.add(team.name.toUpperCase());
  const preset = CAPTAIN_TEAM_PRESETS.find((item) => !used.has(item.name.toUpperCase()));
  return { name: preset?.name ?? '', logo: preset?.logo ?? '' };
}

export async function currentMatchTeams(matchId: number): Promise<CurrentMatchTeam[]> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { captainPosition: true },
  });
  if (!match) throw notFound('赛事不存在');
  const teams = await prisma.team.findMany({
    where: {
      matchId,
      captainSignup: {
        isWaitlisted: false,
        ...(match.captainPosition ? { mainPosition: match.captainPosition } : { isCaptain: true }),
      },
    },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      logo: true,
      captainSignup: {
        select: {
          userId: true,
          user: { select: { username: true, profile: { select: { gameName: true } } } },
        },
      },
    },
  });
  return teams.flatMap((team) =>
    team.captainSignup
      ? [
          {
            id: team.id,
            name: team.name,
            logo: teamLogo(team.name, team.logo),
            captainUserId: team.captainSignup.userId,
            captainName:
              team.captainSignup.user.profile?.gameName || team.captainSignup.user.username,
          },
        ]
      : [],
  );
}

export async function assertUniqueCaptainName(
  tx: Prisma.TransactionClient,
  matchId: number,
  name: string,
  exceptId?: number,
) {
  if (
    await tx.matchSignup.findFirst({
      where: {
        matchId,
        captainTeamName: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    })
  )
    throw badRequest('本场已有同名队伍，请更换队名');
}

export async function releaseCaptainTeam(tx: Prisma.TransactionClient, signupId: number) {
  const team = await tx.team.findUnique({ where: { captainSignupId: signupId } });
  if (!team) return;
  const match = await tx.match.findUniqueOrThrow({ where: { id: team.matchId } });
  if (
    match.status !== 'CREATED' ||
    (await tx.matchScore.count({ where: { matchId: team.matchId } })) ||
    (await tx.matchGameRecord.count({ where: { matchId: team.matchId } }))
  )
    throw badRequest('已有比赛结果，不能删除队长及其队伍');
  const members = await tx.matchSignup.findMany({ where: { teamId: team.id } });
  for (const member of members)
    await tx.matchSignup.update({
      where: { id: member.id },
      data: {
        teamId: null,
        teamPosition: '',
        positionOrder: 0,
        isCaptain: false,
        isWaitlisted: member.isWaitlisted || member.waitlistOrigin,
      },
    });
  await tx.team.delete({ where: { id: team.id } });
  await tx.match.update({
    where: { id: team.matchId },
    data: { teamCount: await tx.team.count({ where: { matchId: team.matchId } }) },
  });
}

export async function captainTeamSettings(matchId: number, userId: number) {
  const sign = await prisma.matchSignup.findUnique({
    where: { userId_matchId: { userId, matchId } },
    include: { match: true, team: true },
  });
  if (!sign) throw notFound('请先报名本场赛事');
  if (
    sign.isWaitlisted ||
    !(sign.match.captainPosition
      ? sign.mainPosition === sign.match.captainPosition
      : sign.isCaptain)
  )
    throw forbidden('仅本场正式队长可设置队伍');
  let editable = true;
  try {
    await assertCaptainTeamsEditable(prisma, matchId);
  } catch {
    editable = false;
  }
  const fallback = await defaultCaptainTeam(matchId);
  return {
    name: sign.captainTeamName || sign.team?.name || fallback.name,
    logo: sign.captainTeamLogo || sign.team?.logo || teamLogo(sign.team?.name) || fallback.logo,
    editable,
  };
}

export async function saveCaptainTeamSettings(
  matchId: number,
  userId: number,
  body: Record<string, unknown>,
) {
  const current = await captainTeamSettings(matchId, userId);
  if (!current.editable) throw badRequest('已开始选人或比赛，队伍设置已锁定');
  const name = String(body.team_name ?? '').trim();
  if (!name || name.length > 20) throw badRequest('队名须为 1–20 个字符');
  const prepared = await prepareCaptainLogo(
    matchId,
    userId,
    String(body.team_logo ?? ''),
    body.logo_file,
    current.logo,
  );
  try {
    const replacedLogo = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
      const match = await assertCaptainTeamsEditable(tx, matchId);
      const sign = await tx.matchSignup.findUnique({
        where: { userId_matchId: { userId, matchId } },
        include: { team: true },
      });
      if (
        !sign ||
        sign.isWaitlisted ||
        !(match.captainPosition ? sign.mainPosition === match.captainPosition : sign.isCaptain)
      )
        throw forbidden('仅本场正式队长可设置队伍');
      const invalid = validateCaptainTeam(name, prepared.logo);
      if (invalid) throw badRequest(invalid);
      const oldLogo = sign.captainTeamLogo || sign.team?.logo || teamLogo(sign.team?.name);
      if (!prepared.uploaded && !isPresetTeamLogo(prepared.logo) && prepared.logo !== oldLogo)
        throw badRequest('队标已更新，请重新打开队伍设置');
      await assertUniqueCaptainName(tx, matchId, name, sign.id);
      await tx.matchSignup.update({
        where: { id: sign.id },
        data: { captainTeamName: name, captainTeamLogo: prepared.logo },
      });
      await syncCaptainTeams(tx, matchId);
      return oldLogo;
    });
    if (replacedLogo !== prepared.logo) await cleanupCaptainLogo(replacedLogo);
  } catch (error) {
    if (prepared.uploaded) await cleanupCaptainLogo(prepared.logo);
    throw error;
  }
  return { ok: true };
}
