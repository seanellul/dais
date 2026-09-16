import "server-only";
import type { Route } from "next";
import { desc, eq, inArray } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, requireOrganiserBySlug } from "@/server/auth/guards";
import { auditLog, getDb, organisations, tournaments } from "@/server/db";
import { isAppError } from "@/server/errors";
import { loadGraph, toSchedule } from "@/server/services/graph";
import { checklistStatus } from "@/server/services/checklist";
import { drawStatus } from "@/server/services/draw";
import { buildLiveBoard } from "@/server/services/live";
import { buildResultsView } from "@/server/services/results";
import { getFinalistConfirmation } from "@/server/services/finalists";

export async function organiserIdentity() {
  const current = await getCurrentUser();
  if (!current) redirect("/signin" as Route);
  return current;
}
export async function organiserTournaments() {
  const current = await organiserIdentity();
  const db = await getDb();
  const ids = current.memberships.map((m) => m.organisationId);
  const [rows, orgs] = ids.length
    ? await Promise.all([
        db
          .select({
            id: tournaments.id,
            name: tournaments.name,
            slug: tournaments.slug,
            kind: tournaments.kind,
            status: tournaments.status,
            organisationId: tournaments.organisationId,
          })
          .from(tournaments)
          .where(inArray(tournaments.organisationId, ids))
          .orderBy(desc(tournaments.createdAt)),
        db
          .select({ id: organisations.id, name: organisations.name, isDemo: organisations.isDemo })
          .from(organisations)
          .where(inArray(organisations.id, ids)),
      ])
    : [[], []];
  return {
    tournaments: rows,
    organisations: orgs,
    ownerOrganisationIds: current.memberships
      .filter((m) => m.role === "owner")
      .map((m) => m.organisationId),
  };
}
export async function organiserTournament(slug: string) {
  let access;
  try {
    access = await requireOrganiserBySlug(slug);
  } catch (error) {
    if (isAppError(error) && error.code === "unauthenticated") redirect("/signin" as Route);
    if (isAppError(error) && ["not_found", "forbidden"].includes(error.code)) notFound();
    throw error;
  }
  const db = await getDb();
  const graph = await loadGraph(db, access.tournament.id);
  const [checklist, draw, activity, results] = await Promise.all([
    checklistStatus(db, graph.tournament.id),
    drawStatus(db, graph.tournament.id),
    db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        actorName: auditLog.actorName,
        action: auditLog.action,
        entityType: auditLog.entityType,
        reason: auditLog.reason,
        diff: auditLog.diff,
      })
      .from(auditLog)
      .where(eq(auditLog.tournamentId, graph.tournament.id))
      .orderBy(desc(auditLog.id))
      .limit(150),
    Promise.all(
      graph.divisions.map(async (d) => {
        const view = buildResultsView(graph, d.code);
        return { ...view, confirmation: await getFinalistConfirmation(db, view) };
      }),
    ),
  ]);
  return {
    tournament: {
      id: graph.tournament.id,
      name: graph.tournament.name,
      slug: graph.tournament.slug,
      kind: graph.tournament.kind,
      status: graph.tournament.status,
      organisationId: graph.tournament.organisationId,
      settings: toSchedule(graph).settings,
      scoringPolicy: graph.tournament.scoringPolicy,
    },
    owner: access.membership.role === "owner",
    checklist,
    draw: { ...draw, publishedAt: draw.publishedAt?.toISOString() ?? null },
    teams: graph.teams.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      school: t.school,
      divisionCode: t.divisionCode,
      seed: t.seed,
      status: t.status,
      speakers: graph.speakers
        .filter((s) => s.teamId === t.id)
        .map((s) => ({ id: s.id, name: s.name, position: s.position, status: s.status })),
    })),
    judges: graph.judges.map((j) => ({
      id: j.id,
      name: j.name,
      code: j.code,
      status: j.status,
      homeRoomId: j.homeRoomId,
      devices: graph.judgeDevices
        .filter((d) => d.judgeId === j.id)
        .map((d) => ({
          deviceId: d.deviceId,
          lastSeenAt: d.lastSeenAt.toISOString(),
          queuedCount: d.queuedCount,
          appVersion: d.appVersion,
          statuses: d.statuses,
        })),
    })),
    rooms: graph.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      sortOrder: r.sortOrder,
      judgeIds: graph.judges
        .filter((j) => j.homeRoomId === r.id && j.status === "active")
        .map((j) => j.id),
    })),
    debates: toSchedule(graph).debates,
    assignments: graph.assignments.map((a) => ({
      id: a.id,
      judgeId: a.judgeId,
      debateId: a.debateId,
      round: a.identity.round,
      live: a.live,
      identity: a.identity,
      display: a.display,
      successorId: a.successorId,
    })),
    sheets: graph.sheets.map((s) => ({
      assignmentId: s.assignmentId,
      version: s.version,
      scores: s.scores,
      sideFlipped: s.sideFlipped,
      roleSwaps: s.roleSwaps,
      source: s.source,
      receivedAt: s.receivedAt.toISOString(),
      reason: s.reason,
    })),
    conflicts: graph.conflicts.map((c) => ({
      id: c.id,
      assignmentId: c.assignmentId,
      incoming: c.incoming,
      kind: c.kind,
    })),
    boards: graph.rounds.map((r) => buildLiveBoard(graph, r.number, new Date())),
    results,
    activity: activity.map((a) => ({ ...a, diff: safeAuditDiff(a.diff), at: a.at.toISOString() })),
  };
}
export type OrganiserData = Awaited<ReturnType<typeof organiserTournament>>;
export type TournamentListData = Awaited<ReturnType<typeof organiserTournaments>>;

function safeAuditDiff(value: unknown): unknown {
  const secret = /(password|token|cookie|sessionEpoch|ipHash|requestKey|identityHash)/i;
  function scrub(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !secret.test(k))
          .map(([k, item]) => [k, scrub(item)]),
      );
    return v;
  }
  return Array.isArray(value)
    ? value
        .filter(
          (v) =>
            v !== null &&
            typeof v === "object" &&
            (!("path" in v) ||
              !Array.isArray(v.path) ||
              !v.path.some((p: unknown) => secret.test(String(p)))),
        )
        .map(scrub)
    : null;
}
