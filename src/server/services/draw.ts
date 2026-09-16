/**
 * The draw: preview, save, edit, publish.
 *
 * Saving a draw is the one write that can change which sheets exist, so it
 * follows a fixed algorithm (the plan's "setup / draw save"):
 *
 *  1. Lock the tournament row and compare `revision` with the revision the
 *     page was loaded at; a mismatch is `setup_stale`.
 *  2. Reconcile the incoming debates with the stored rows (below), build the
 *     next schedule and validate it in draft mode; blockers are refused.
 *  3. Derive the next assignments from the previous ones: unchanged slots keep
 *     their id, changed slots retire with a successor, removed slots retire
 *     without one (`deriveAssignments`).
 *  4. Lock the affected divisions; a published division cannot change.
 *  5. Protect scored work: a retiring slot that holds a sheet or an open
 *     "two versions" is refused unless the organiser said `allowOrphans` with
 *     a reason. The sheet then stays on the old assignment, flagged orphaned.
 *  6. Apply the rows, bump the revision, store the setup snapshot, audit.
 *
 * Reconciling debate ids. The editor sends debates with the ids it loaded;
 * a preview sends fresh domain ids. A stored debate row cannot be deleted
 * once it has assignments (they are history and may hold sheets), so an
 * incoming debate is matched to a stored row whenever it can be: by id when
 * the opponents are unchanged, then by the pair of opponents, then by id,
 * then by round and room, then by round, then by division. Rows nobody
 * claims are removed, which the service allows only while nothing refers to
 * their assignments.
 *
 * Applying the rows. Postgres checks unique constraints statement by
 * statement, so two debates swapping rooms would fail half way. Changed rows
 * are therefore updated in an order that never collides; a cycle (a plain
 * room swap) is broken by parking one debate in a temporary room that is
 * deleted before the transaction ends.
 *
 * Draw status. The schema has no "published" column, so publishing writes an
 * audit row `draw.published` with the revision it published. The status is
 * read back from the latest such row: none -> draft, same revision ->
 * published, later revision -> changed. A `draw_published_revision` column
 * would be the tidier home; see the track report.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { generateDraw, generateSeed, type DrawMethod } from "@/domain/draw";
import {
  affectedDivisions,
  canonicalJson,
  deriveAssignments,
  hasBlockers,
  scheduleIssues,
  scoredSlotsAtRisk,
  validateSchedule,
  type DeriveResult,
  type RetiredSlot,
  type ScheduleIssue,
} from "@/domain/schedule";
import type { Assignment, Debate, Schedule } from "@/domain/types";
import {
  assignments,
  auditLog,
  conflicts,
  debateJudges,
  debateTeams,
  debates,
  divisions,
  rooms,
  scoreOverrides,
  setupRevisions,
  sheetVersions,
  sheetWaivers,
  sheets,
  tournaments,
  type DebateRow,
  type Tx,
} from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, diffOf, recordAudit } from "./audit";
import type { Queryable, ServiceContext } from "./context";
import { loadGraph, toSchedule, type GraphAssignment, type TournamentGraph } from "./graph";
import { fingerprintOf, newId } from "./ids";
import { snapshotTournament } from "./snapshots";
import { lockTournament } from "./tournaments";

/** Audit action for publishing; the integrate step should move it into `AUDIT_ACTIONS`. */
export const DRAW_PUBLISHED_ACTION = "draw.published";

/** The `retired_reason` texts; judges read them, so they use the tournament vocabulary. */
export const RETIRED_REASONS = {
  "matchup-changed": "The draw changed.",
  "slot-removed": "This debate was taken out of the draw.",
} as const;

/** A debate as the draw editor or a preview sends it. An unknown or missing id means a new debate. */
export interface DebateInput {
  id?: string;
  divisionCode: string;
  round: number;
  roomId: string;
  governmentTeamId: string;
  oppositionTeamId: string;
  /** In seat order. */
  judgeIds: string[];
  motion?: string;
}

export interface PreviewDrawInput {
  divisionCodes: string[];
  /** Any text; a fresh seed is generated when omitted. */
  seed?: string;
  method?: DrawMethod;
  /** How many rounds to draw; all of them by default. */
  rounds?: number;
}

export interface DrawPreview {
  /** The whole schedule's debates: other divisions unchanged, the drawn ones new. */
  debates: Debate[];
  seed: string;
  /** From the draw itself: rooms short of judges and the like. */
  warnings: string[];
  /** Draft-mode checks over the resulting schedule. */
  issues: ScheduleIssue[];
}

export interface SaveDrawInput {
  /** The tournament revision the page was loaded at. */
  baseRevision: number;
  debates: DebateInput[];
  /** Stored on the tournament so the draw can be reproduced. */
  seed?: string;
  /** Retire sheets that already hold scores. Needs a reason. */
  allowOrphans?: boolean;
  reason?: string;
}

export interface SaveDrawResult {
  revision: number;
  /** Assignments whose id survived. */
  kept: number;
  created: number;
  retired: RetiredSlot[];
  /** Retired assignments that hold a sheet; the sheet stays on them, set aside. */
  orphaned: string[];
  /** Debates taken out of the draw. */
  removed: number;
  /** Warnings from the draft-mode checks. Blockers are refused, so none appear here. */
  warnings: ScheduleIssue[];
}

export interface DebatePatch {
  roomId?: string;
  governmentTeamId?: string;
  oppositionTeamId?: string;
  judgeIds?: string[];
  motion?: string;
}

export interface EditDebateInput {
  baseRevision: number;
  debateId: string;
  patch: DebatePatch;
  allowOrphans?: boolean;
  reason?: string;
}

export interface SwapTeamsInput {
  baseRevision: number;
  round: number;
  /** The two teams to exchange. In one debate they swap sides; in two debates they swap places. */
  teamId: string;
  otherTeamId: string;
  allowOrphans?: boolean;
  reason?: string;
}

export type DrawStatusKind = "draft" | "published" | "changed";

export interface DrawStatus {
  status: DrawStatusKind;
  revision: number;
  publishedRevision: number | null;
  publishedAt: Date | null;
}

/** How an internal caller asks for the schedule to be re-applied. */
export interface ScheduleChange {
  /** The next debates, or "current" to re-derive assignments after a roster or display change. */
  debates: DebateInput[] | "current";
  /** Compare-and-set target; omitted by internal callers that hold the lock already. */
  expectedRevision?: number;
  seed?: string;
  allowOrphans?: boolean;
  reason?: string;
  /** The audit row for the change, or null when the caller records its own. */
  audit: { action: string; entityType: string; entityId: string | null } | null;
}

// ---------------------------------------------------------------------------
// Preview

/**
 * Generates a draw for the given divisions over the current roster. Nothing
 * is written: the caller shows the debates and saves them with `saveDraw`.
 */
export async function previewDraw(
  db: Queryable,
  ctx: ServiceContext,
  tournamentId: string,
  input: PreviewDrawInput,
): Promise<DrawPreview> {
  const schedule = toSchedule(await loadGraph(db, tournamentId));
  const seed = input.seed?.trim() || generateSeed({ year: ctx.now().getFullYear() });
  const result = generateDraw({
    schedule,
    divisionCodes: input.divisionCodes,
    seed,
    method: input.method ?? "random",
    rounds: input.rounds,
  });
  if (!result.ok) throw errors.validation(result.error.message, { code: result.error.code });
  const issues = scheduleIssues({ ...schedule, debates: result.debates });
  ctx.log.info(
    { tournamentId, seed: result.seed, debates: result.debates.length, issues: issues.length },
    "Draw previewed",
  );
  return { debates: result.debates, seed: result.seed, warnings: result.warnings, issues };
}

// ---------------------------------------------------------------------------
// Save, edit, swap

/** Saves a whole draw (see the module comment for the algorithm). */
export async function saveDraw(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: SaveDrawInput,
): Promise<SaveDrawResult> {
  return applyScheduleChange(tx, ctx, tournamentId, {
    debates: input.debates,
    expectedRevision: input.baseRevision,
    seed: input.seed,
    allowOrphans: input.allowOrphans,
    reason: input.reason,
    audit: { action: AUDIT_ACTIONS.drawSaved, entityType: "tournament", entityId: tournamentId },
  });
}

/** Changes one debate's room, teams, panel or motion and saves the draw. */
export async function editDebate(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: EditDebateInput,
): Promise<SaveDrawResult> {
  const schedule = toSchedule(await loadGraph(tx, tournamentId));
  const target = schedule.debates.find((debate) => debate.id === input.debateId);
  if (!target) throw errors.notFound("That debate");
  const next = schedule.debates.map((debate) =>
    debate.id === input.debateId ? { ...debate, ...input.patch } : debate,
  );
  return applyScheduleChange(tx, ctx, tournamentId, {
    debates: next,
    expectedRevision: input.baseRevision,
    allowOrphans: input.allowOrphans,
    reason: input.reason,
    audit: { action: AUDIT_ACTIONS.drawEdited, entityType: "debate", entityId: input.debateId },
  });
}

/**
 * Exchanges two teams within one round. When both are in the same debate
 * the sides swap; otherwise each takes the other's place.
 */
export async function swapTeams(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: SwapTeamsInput,
): Promise<SaveDrawResult> {
  if (input.teamId === input.otherTeamId) {
    throw errors.validation("Choose two different teams to swap.");
  }
  const schedule = toSchedule(await loadGraph(tx, tournamentId));
  const inRound = schedule.debates.filter((debate) => debate.round === input.round);
  const first = debateOfTeam(inRound, input.teamId);
  const second = debateOfTeam(inRound, input.otherTeamId);
  if (!first || !second) {
    throw errors.validation(`Both teams must be in the draw for round ${input.round}.`);
  }
  const swapped = new Map<string, Debate>();
  if (first.id === second.id) {
    swapped.set(first.id, {
      ...first,
      governmentTeamId: first.oppositionTeamId,
      oppositionTeamId: first.governmentTeamId,
    });
  } else {
    swapped.set(first.id, replaceTeam(first, input.teamId, input.otherTeamId));
    swapped.set(second.id, replaceTeam(second, input.otherTeamId, input.teamId));
  }
  const next = schedule.debates.map((debate) => swapped.get(debate.id) ?? debate);
  return applyScheduleChange(tx, ctx, tournamentId, {
    debates: next,
    expectedRevision: input.baseRevision,
    allowOrphans: input.allowOrphans,
    reason: input.reason,
    audit: { action: AUDIT_ACTIONS.drawEdited, entityType: "debate", entityId: first.id },
  });
}

function debateOfTeam(list: readonly Debate[], teamId: string): Debate | undefined {
  return list.find(
    (debate) => debate.governmentTeamId === teamId || debate.oppositionTeamId === teamId,
  );
}

function replaceTeam(debate: Debate, from: string, to: string): Debate {
  return {
    ...debate,
    governmentTeamId: debate.governmentTeamId === from ? to : debate.governmentTeamId,
    oppositionTeamId: debate.oppositionTeamId === from ? to : debate.oppositionTeamId,
  };
}

/**
 * Re-derives the assignments for the current debates. Teams, judges, rooms
 * and rounds call this after a change that alters what a sheet shows (a
 * renamed room) or who it is for (a replaced debater). The revision is
 * bumped so an open draw editor learns that setup moved on.
 */
export async function refreshAssignments(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  options: Pick<ScheduleChange, "allowOrphans" | "reason" | "expectedRevision"> = {},
): Promise<SaveDrawResult> {
  return applyScheduleChange(tx, ctx, tournamentId, {
    ...options,
    debates: "current",
    audit: null,
  });
}

// ---------------------------------------------------------------------------
// Publish and status

/**
 * Marks the current revision as the published draw. The draw must be
 * complete: every active team in every round, panels on every debate.
 */
export async function publishDraw(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: { baseRevision: number },
): Promise<DrawStatus> {
  const tournament = await lockTournament(tx, tournamentId);
  if (tournament.revision !== input.baseRevision) {
    throw errors.setupStale({
      currentRevision: tournament.revision,
      baseRevision: input.baseRevision,
    });
  }
  const schedule = toSchedule(await loadGraph(tx, tournamentId));
  const complete = validateSchedule(schedule, { requireComplete: true });
  if (!complete.ok && hasBlockers(complete.issues)) {
    throw drawRefused("The draw isn't complete yet.", complete.issues);
  }
  const now = ctx.now();
  if (tournament.status === "setup") {
    await tx
      .update(tournaments)
      .set({ status: "running", updatedAt: now })
      .where(eq(tournaments.id, tournamentId));
  }
  await recordAudit(tx, ctx, {
    tournamentId,
    action: DRAW_PUBLISHED_ACTION,
    entityType: "tournament",
    entityId: tournamentId,
    after: { revision: tournament.revision, debates: schedule.debates.length },
  });
  return {
    status: "published",
    revision: tournament.revision,
    publishedRevision: tournament.revision,
    publishedAt: now,
  };
}

/** Whether the draw is a draft, published, or changed since it was published. */
export async function drawStatus(db: Queryable, tournamentId: string): Promise<DrawStatus> {
  const [tournament] = await db
    .select({ revision: tournaments.revision })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1);
  if (!tournament) throw errors.notFound("That tournament");
  const [published] = await db
    .select({ at: auditLog.at, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.tournamentId, tournamentId), eq(auditLog.action, DRAW_PUBLISHED_ACTION)))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(1);
  const publishedRevision = revisionOf(published?.after);
  if (publishedRevision === null) {
    return { status: "draft", revision: tournament.revision, publishedRevision, publishedAt: null };
  }
  return {
    status: publishedRevision === tournament.revision ? "published" : "changed",
    revision: tournament.revision,
    publishedRevision,
    publishedAt: published?.at ?? null,
  };
}

function revisionOf(after: unknown): number | null {
  if (!after || typeof after !== "object") return null;
  const { revision } = after as { revision?: unknown };
  return typeof revision === "number" ? revision : null;
}

// ---------------------------------------------------------------------------
// The save algorithm

/** Runs the save algorithm for a change to the schedule. Every write path above ends here. */
export async function applyScheduleChange(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  change: ScheduleChange,
): Promise<SaveDrawResult> {
  // 1. Lock and compare-and-set.
  const tournament = await lockTournament(tx, tournamentId);
  if (change.expectedRevision !== undefined && tournament.revision !== change.expectedRevision) {
    throw errors.setupStale({
      currentRevision: tournament.revision,
      baseRevision: change.expectedRevision,
    });
  }
  const graph = await loadGraph(tx, tournamentId);
  const previous = toSchedule(graph);
  const nextRevision = tournament.revision + 1;

  // 2. Reconcile ids, build and validate the next schedule.
  const plan =
    change.debates === "current"
      ? { debates: previous.debates, removed: [] as DebateRow[] }
      : reconcileDebates(graph, change.debates);
  const next: Schedule = { ...previous, debates: plan.debates, revision: nextRevision };
  const issues = scheduleIssues(next);
  if (hasBlockers(issues)) throw drawRefused("The draw can't be saved yet.", issues);

  // 3. Derive assignments.
  const previousAssignments = graph.assignments.map(toDomainAssignment);
  const derived = deriveAssignments(next, previousAssignments);
  if (derived.skipped.length) {
    throw errors.validation(
      `The draw can't be saved yet. ${derived.skipped.map((slot) => slot.reason).join(" ")}`,
      { issues: derived.skipped.map((slot) => ({ path: slot.debateId, message: slot.reason })) },
    );
  }

  // 4. Affected divisions; a published one refuses.
  const affected = affectedDivisions(
    { schedule: previous, assignments: previousAssignments },
    { schedule: next, assignments: derived.assignments },
  );
  await lockAffectedDivisions(tx, tournamentId, affected);

  // 5. Protection: removed debates that are referenced, then scored slots.
  const removedAssignmentIds = await assignmentsOfRemovedDebates(tx, graph, plan.removed);
  const scored = scoredAssignmentIds(graph);
  const atRisk = scoredSlotsAtRisk(derived.retired, scored);
  const reason = change.reason?.trim() ?? "";
  if (atRisk.length > 0 && !(change.allowOrphans && reason.length > 0)) {
    throw scoredRefused(graph, atRisk);
  }
  // A backup point whenever sheets exist and the draw retires anything.
  if (graph.sheets.length > 0 && derived.retired.length > 0) {
    await snapshotTournament(tx, ctx, tournamentId, "pre_draw_save", {
      label: `Before the draw changed (revision ${nextRevision})`,
    });
  }

  // 6. Apply.
  const now = ctx.now();
  await applyDebateRows(tx, tournamentId, graph, plan, removedAssignmentIds, now);
  const counts = await applyAssignmentRows(
    tx,
    tournamentId,
    graph,
    derived,
    removedAssignmentIds,
    nextRevision,
    now,
  );
  await tx
    .update(tournaments)
    .set({ revision: nextRevision, drawSeed: change.seed ?? tournament.drawSeed, updatedAt: now })
    .where(eq(tournaments.id, tournamentId));
  await tx.insert(setupRevisions).values({
    tournamentId,
    revision: nextRevision,
    snapshot: next,
    author: ctx.actor.name,
    at: now,
  });

  // 7. Audit.
  const orphaned = atRisk.map((slot) => slot.id);
  for (const assignmentId of orphaned) {
    const assignment = graph.assignments.find((row) => row.id === assignmentId);
    await recordAudit(tx, ctx, {
      tournamentId,
      action: AUDIT_ACTIONS.drawSheetOrphaned,
      entityType: "assignment",
      entityId: assignmentId,
      assignmentId,
      divisionCode: assignment?.identity.divisionCode ?? null,
      reason,
      after: { successorId: atRisk.find((slot) => slot.id === assignmentId)?.successorId ?? null },
    });
  }
  const summary = {
    revision: nextRevision,
    kept: counts.kept,
    created: counts.created,
    retired: derived.retired.length,
    orphaned: orphaned.length,
    removed: plan.removed.length,
    deletedAssignmentIds: [...removedAssignmentIds],
  };
  if (change.audit) {
    await recordAudit(tx, ctx, {
      tournamentId,
      ...change.audit,
      reason: reason || null,
      diff: diffOf(compactDraw(previous), compactDraw(next)),
      after: summary,
    });
  }
  ctx.log.info({ tournamentId, ...summary }, "Schedule saved");
  return {
    revision: nextRevision,
    kept: counts.kept,
    created: counts.created,
    retired: derived.retired,
    orphaned,
    removed: plan.removed.length,
    warnings: issues,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation

interface DebatePlan {
  debates: Debate[];
  removed: DebateRow[];
}

function pairKeyOf(debate: { governmentTeamId: string; oppositionTeamId: string }): string {
  return [debate.governmentTeamId, debate.oppositionTeamId].sort().join(":");
}

/** Matches incoming debates to stored rows so that rows are reused rather than deleted (module comment). */
function reconcileDebates(graph: TournamentGraph, inputs: DebateInput[]): DebatePlan {
  const free = new Map<string, DebateRow>(graph.debates.map((row) => [row.id, row]));
  const chosen: (string | undefined)[] = inputs.map(() => undefined);
  const findFree = (test: (row: DebateRow) => boolean) => {
    for (const row of free.values()) if (test(row)) return row;
    return undefined;
  };
  const byId = (input: DebateInput) => (input.id ? free.get(input.id) : undefined);
  const passes: ((input: DebateInput) => DebateRow | undefined)[] = [
    (input) => {
      const row = byId(input);
      return row && pairKeyOf(row) === pairKeyOf(input) ? row : undefined;
    },
    (input) =>
      findFree(
        (row) => row.divisionCode === input.divisionCode && pairKeyOf(row) === pairKeyOf(input),
      ),
    byId,
    (input) =>
      findFree(
        (row) =>
          row.divisionCode === input.divisionCode &&
          row.round === input.round &&
          row.roomId === input.roomId,
      ),
    (input) =>
      findFree((row) => row.divisionCode === input.divisionCode && row.round === input.round),
    (input) => findFree((row) => row.divisionCode === input.divisionCode),
  ];
  for (const pass of passes) {
    inputs.forEach((input, index) => {
      if (chosen[index] !== undefined) return;
      const row = pass(input);
      if (!row) return;
      chosen[index] = row.id;
      free.delete(row.id);
    });
  }
  const debatesOut = inputs.map((input, index): Debate => ({
    id: chosen[index] ?? newId(),
    divisionCode: input.divisionCode,
    round: input.round,
    roomId: input.roomId,
    governmentTeamId: input.governmentTeamId,
    oppositionTeamId: input.oppositionTeamId,
    judgeIds: [...input.judgeIds],
    motion: (input.motion ?? "").trim(),
  }));
  return { debates: debatesOut, removed: [...free.values()] };
}

// ---------------------------------------------------------------------------
// Checks

function drawRefused(lead: string, issues: readonly ScheduleIssue[]) {
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  const message =
    blockers.length === 1
      ? `${lead} ${blockers[0].message}`
      : `${lead} ${blockers.map((issue) => issue.message).join(" ")}`;
  return errors.validation(message, { issues });
}

async function lockAffectedDivisions(
  tx: Tx,
  tournamentId: string,
  codes: readonly string[],
): Promise<void> {
  if (codes.length === 0) return;
  const rows = await tx
    .select()
    .from(divisions)
    .where(and(eq(divisions.tournamentId, tournamentId), inArray(divisions.code, [...codes])))
    .orderBy(asc(divisions.id))
    .for("update");
  const published = rows.find((row) => row.finalizedAt !== null);
  if (published) {
    throw errors.divisionFinalized({
      divisionCode: published.code,
      finalizedAt: published.finalizedAt?.toISOString(),
    });
  }
}

/** Assignment ids that hold a sheet or an open "two versions". */
function scoredAssignmentIds(graph: TournamentGraph): Set<string> {
  const ids = new Set(graph.sheets.map((sheet) => sheet.assignmentId));
  for (const conflict of graph.conflicts)
    if (conflict.status === "open") ids.add(conflict.assignmentId);
  return ids;
}

/**
 * The assignments of debates being taken out of the draw. Their rows go with
 * the debate (the debates table cannot keep a row without a room and teams),
 * which is allowed only while nothing refers to them: no sheet, version,
 * "two versions", waiver or override. Otherwise the removal is refused.
 */
async function assignmentsOfRemovedDebates(
  tx: Tx,
  graph: TournamentGraph,
  removed: readonly DebateRow[],
): Promise<Set<string>> {
  if (removed.length === 0) return new Set();
  const removedIds = new Set(removed.map((row) => row.id));
  const candidates = graph.assignments.filter((row) => removedIds.has(row.debateId));
  const ids = candidates.map((row) => row.id);
  if (ids.length === 0) return new Set();

  const referenced = await referencedAssignmentIds(tx, graph.tournament.id, ids);
  if (referenced.size > 0) {
    const debate = candidates.find((row) => referenced.has(row.id));
    const where = debate ? describeAssignment(graph, debate) : "This debate";
    throw errors.validation(
      `${where} already has sheets, so it can't be taken out of the draw. Change its teams or room instead.`,
      { code: "debate_scored", assignmentIds: [...referenced] },
    );
  }
  return new Set(ids);
}

async function referencedAssignmentIds(
  tx: Tx,
  tournamentId: string,
  ids: string[],
): Promise<Set<string>> {
  const tables = [sheets, sheetVersions, conflicts, sheetWaivers, scoreOverrides] as const;
  const found = new Set<string>();
  for (const table of tables) {
    const rows = await tx
      .select({ assignmentId: table.assignmentId })
      .from(table)
      .where(and(eq(table.tournamentId, tournamentId), inArray(table.assignmentId, ids)));
    for (const row of rows) if (row.assignmentId) found.add(row.assignmentId);
  }
  return found;
}

function describeAssignment(graph: TournamentGraph, assignment: GraphAssignment): string {
  return `Round ${assignment.identity.round} in ${assignment.display.roomName}`;
}

function scoredRefused(graph: TournamentGraph, atRisk: readonly RetiredSlot[]) {
  const byId = new Map(graph.assignments.map((row) => [row.id, row]));
  const perDebate = new Map<string, { where: string; judges: string[]; assignmentIds: string[] }>();
  for (const slot of atRisk) {
    const assignment = byId.get(slot.id);
    if (!assignment) continue;
    const entry = perDebate.get(assignment.debateId) ?? {
      where: describeAssignment(graph, assignment),
      judges: [],
      assignmentIds: [],
    };
    entry.judges.push(assignment.display.judgeName);
    entry.assignmentIds.push(assignment.id);
    perDebate.set(assignment.debateId, entry);
  }
  const lines = [...perDebate.values()].map(
    (entry) =>
      `${entry.where} already has ${entry.judges.length === 1 ? "a sheet" : `${entry.judges.length} sheets`} (${entry.judges.join(", ")}).`,
  );
  return errors.validation(
    `${lines.join(" ")} Changing the draw sets those sheets aside. Give a reason to go ahead.`,
    {
      code: "debate_scored",
      debates: [...perDebate.entries()].map(([debateId, entry]) => ({ debateId, ...entry })),
    },
  );
}

// ---------------------------------------------------------------------------
// Applying debate rows

interface Occupant {
  round: number;
  roomId: string;
  divisionCode: string;
  pair: string;
}

function occupantOf(debate: {
  round: number;
  roomId: string;
  divisionCode: string;
  governmentTeamId: string;
  oppositionTeamId: string;
}): Occupant {
  return {
    round: debate.round,
    roomId: debate.roomId,
    divisionCode: debate.divisionCode,
    pair: pairKeyOf(debate),
  };
}

function panelsByDebate(graph: TournamentGraph): Map<string, string[]> {
  const byDebate = new Map<string, string[]>();
  for (const row of [...graph.debateJudges].sort((a, b) => a.seat - b.seat)) {
    byDebate.set(row.debateId, [...(byDebate.get(row.debateId) ?? []), row.judgeId]);
  }
  return byDebate;
}

function rowDiffers(row: DebateRow, judgeIds: readonly string[], debate: Debate): boolean {
  return (
    row.divisionCode !== debate.divisionCode ||
    row.round !== debate.round ||
    row.roomId !== debate.roomId ||
    row.governmentTeamId !== debate.governmentTeamId ||
    row.oppositionTeamId !== debate.oppositionTeamId ||
    row.motion !== debate.motion ||
    canonicalJson(judgeIds) !== canonicalJson(debate.judgeIds)
  );
}

async function applyDebateRows(
  tx: Tx,
  tournamentId: string,
  graph: TournamentGraph,
  plan: DebatePlan,
  removedAssignmentIds: Set<string>,
  now: Date,
): Promise<void> {
  const existing = new Map(graph.debates.map((row) => [row.id, row]));
  const panels = panelsByDebate(graph);
  const changed: Debate[] = [];
  const inserted: Debate[] = [];
  for (const debate of plan.debates) {
    const row = existing.get(debate.id);
    if (!row) inserted.push(debate);
    else if (rowDiffers(row, panels.get(row.id) ?? [], debate)) changed.push(debate);
  }
  const removedIds = plan.removed.map((row) => row.id);
  const touched = [...changed.map((debate) => debate.id), ...removedIds];

  if (removedAssignmentIds.size > 0) {
    await tx
      .delete(assignments)
      .where(
        and(
          eq(assignments.tournamentId, tournamentId),
          inArray(assignments.id, [...removedAssignmentIds]),
        ),
      );
  }
  if (touched.length > 0) {
    await tx.delete(debateJudges).where(inArray(debateJudges.debateId, touched));
    await tx.delete(debateTeams).where(inArray(debateTeams.debateId, touched));
  }
  if (removedIds.length > 0) {
    await tx.delete(debates).where(inArray(debates.id, removedIds));
  }
  await updateChangedRows(tx, tournamentId, graph, changed, new Set(removedIds), now);
  if (inserted.length > 0) {
    await tx.insert(debates).values(
      inserted.map((debate) => ({
        id: debate.id,
        tournamentId,
        divisionCode: debate.divisionCode,
        round: debate.round,
        roomId: debate.roomId,
        governmentTeamId: debate.governmentTeamId,
        oppositionTeamId: debate.oppositionTeamId,
        motion: debate.motion,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  await insertChildRows(tx, tournamentId, [...changed, ...inserted]);
}

/**
 * Updates changed rows in an order that never trips a unique constraint,
 * parking a debate in a temporary room when a cycle (a room swap) leaves no
 * other way forward. Pair collisions cannot occur after reconciliation, so
 * only rooms ever need parking.
 */
async function updateChangedRows(
  tx: Tx,
  tournamentId: string,
  graph: TournamentGraph,
  changed: readonly Debate[],
  removedIds: Set<string>,
  now: Date,
): Promise<void> {
  const current = new Map<string, Occupant>();
  for (const row of graph.debates)
    if (!removedIds.has(row.id)) current.set(row.id, occupantOf(row));
  const targets = new Map(changed.map((debate) => [debate.id, occupantOf(debate)]));
  const pending = new Set(changed.map((debate) => debate.id));
  const parkingRooms: string[] = [];

  const blocked = (id: string): boolean => {
    const target = targets.get(id) as Occupant;
    for (const [otherId, other] of current) {
      if (otherId === id) continue;
      if (other.round === target.round && other.roomId === target.roomId) return true;
      if (other.divisionCode === target.divisionCode && other.pair === target.pair) return true;
    }
    return false;
  };

  let parkings = 0;
  while (pending.size > 0) {
    const ready = [...pending].find((id) => !blocked(id));
    if (ready !== undefined) {
      const debate = changed.find((candidate) => candidate.id === ready) as Debate;
      await tx
        .update(debates)
        .set({
          divisionCode: debate.divisionCode,
          round: debate.round,
          roomId: debate.roomId,
          governmentTeamId: debate.governmentTeamId,
          oppositionTeamId: debate.oppositionTeamId,
          motion: debate.motion,
          updatedAt: now,
        })
        .where(and(eq(debates.tournamentId, tournamentId), eq(debates.id, debate.id)));
      current.set(ready, targets.get(ready) as Occupant);
      pending.delete(ready);
      continue;
    }
    parkings += 1;
    if (parkings > changed.length) {
      throw errors.internal(new Error("The draw's room changes could not be ordered."));
    }
    const [parked] = pending;
    const [parking] = await tx
      .insert(rooms)
      .values({ tournamentId, name: `Parking ${newId()}`, sortOrder: 1_000_000 })
      .returning({ id: rooms.id });
    await tx
      .update(debates)
      .set({ roomId: parking.id })
      .where(and(eq(debates.tournamentId, tournamentId), eq(debates.id, parked)));
    current.set(parked, { ...(current.get(parked) as Occupant), roomId: parking.id });
    parkingRooms.push(parking.id);
  }
  if (parkingRooms.length > 0) {
    await tx.delete(rooms).where(inArray(rooms.id, parkingRooms));
  }
}

async function insertChildRows(
  tx: Tx,
  tournamentId: string,
  list: readonly Debate[],
): Promise<void> {
  if (list.length === 0) return;
  await tx.insert(debateTeams).values(
    list.flatMap((debate) => [
      {
        tournamentId,
        debateId: debate.id,
        round: debate.round,
        teamId: debate.governmentTeamId,
        side: "government" as const,
      },
      {
        tournamentId,
        debateId: debate.id,
        round: debate.round,
        teamId: debate.oppositionTeamId,
        side: "opposition" as const,
      },
    ]),
  );
  const panelRows = list.flatMap((debate) =>
    debate.judgeIds.map((judgeId, index) => ({
      tournamentId,
      debateId: debate.id,
      round: debate.round,
      judgeId,
      seat: index + 1,
    })),
  );
  if (panelRows.length > 0) await tx.insert(debateJudges).values(panelRows);
}

// ---------------------------------------------------------------------------
// Applying assignment rows

function toDomainAssignment(row: GraphAssignment): Assignment {
  return {
    id: row.id,
    identity: row.identity,
    display: row.display,
    scheduleRevision: row.scheduleRevision,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    retiredReason: row.retiredReason,
    successorId: row.successorId,
  };
}

/** Retires first (the live-slot index allows one live row per slot), then updates kept rows and inserts new ones. */
async function applyAssignmentRows(
  tx: Tx,
  tournamentId: string,
  graph: TournamentGraph,
  derived: DeriveResult,
  removedAssignmentIds: Set<string>,
  revision: number,
  now: Date,
): Promise<{ kept: number; created: number }> {
  for (const slot of derived.retired) {
    if (removedAssignmentIds.has(slot.id)) continue;
    await tx
      .update(assignments)
      .set({
        retiredAt: now,
        retiredReason: RETIRED_REASONS[slot.reason],
        successorId: slot.successorId,
      })
      .where(and(eq(assignments.tournamentId, tournamentId), eq(assignments.id, slot.id)));
  }

  const liveBefore = new Map(
    graph.assignments.filter((row) => row.live).map((row) => [row.id, row]),
  );
  const revisionOnly: string[] = [];
  const fresh: Assignment[] = [];
  let kept = 0;
  for (const assignment of derived.assignments) {
    const before = liveBefore.get(assignment.id);
    if (!before) {
      fresh.push(assignment);
      continue;
    }
    kept += 1;
    if (canonicalJson(before.display) === canonicalJson(assignment.display)) {
      revisionOnly.push(assignment.id);
      continue;
    }
    await tx
      .update(assignments)
      .set({ display: assignment.display, scheduleRevision: assignment.scheduleRevision })
      .where(and(eq(assignments.tournamentId, tournamentId), eq(assignments.id, assignment.id)));
  }
  if (revisionOnly.length > 0) {
    await tx
      .update(assignments)
      .set({ scheduleRevision: revision })
      .where(
        and(eq(assignments.tournamentId, tournamentId), inArray(assignments.id, revisionOnly)),
      );
  }
  if (fresh.length > 0) {
    await tx.insert(assignments).values(
      fresh.map((assignment) => ({
        tournamentId,
        id: assignment.id,
        debateId: assignment.identity.debateId,
        judgeId: assignment.identity.judgeId,
        identity: assignment.identity,
        identityHash: fingerprintOf(assignment.identity),
        display: assignment.display,
        scheduleRevision: assignment.scheduleRevision,
        createdAt: now,
      })),
    );
  }
  return { kept, created: fresh.length };
}

// ---------------------------------------------------------------------------
// History

/** The draw keyed by debate id with names instead of ids, so the history diff reads as sentences. */
function compactDraw(schedule: Schedule): Record<string, unknown> {
  const roomNames = new Map(schedule.rooms.map((room) => [room.id, room.name]));
  const teamCodes = new Map(schedule.teams.map((team) => [team.id, team.code]));
  const judgeNames = new Map(schedule.judges.map((judge) => [judge.id, judge.name]));
  const out: Record<string, unknown> = {};
  for (const debate of schedule.debates) {
    out[debate.id] = {
      division: debate.divisionCode,
      round: debate.round,
      room: roomNames.get(debate.roomId) ?? debate.roomId,
      government: teamCodes.get(debate.governmentTeamId) ?? debate.governmentTeamId,
      opposition: teamCodes.get(debate.oppositionTeamId) ?? debate.oppositionTeamId,
      judges: debate.judgeIds.map((id) => judgeNames.get(id) ?? id),
      motion: debate.motion,
    };
  }
  return out;
}
