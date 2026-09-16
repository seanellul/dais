/**
 * The simulator: judges' sheets written by the app itself, for demos and
 * sandboxes. A simulated sheet is a normal sheet (a `sheet_versions` row
 * and a `sheets` pointer) whose source is `simulated` and whose actor is
 * the simulator, so the live board, the results page and the exports treat
 * it like any other while still labelling it.
 *
 * Every entry point is deterministic from a seed, gap-free (it fills only
 * the live assignments that have no sheet yet) and idempotent (calling it
 * again writes nothing). Sandbox and demo tournaments may always be
 * simulated. A live tournament may be simulated only until a real sheet
 * arrives; after that the simulator is switched off for good.
 *
 * `insertSimulatedSheet` is a minimal stand-in for `receiveSheet` from the
 * sheets service, which is being written concurrently. Once both exist the
 * integrator should route simulated sheets through `receiveSheet` so the
 * idempotency receipts and conflict rules apply to them too.
 */
import { and, eq, ne, sql } from "drizzle-orm";

import { simulateSheet, type PlantedRogue } from "@/domain/sample";
import { parseSheetPayload } from "@/domain/sheet";
import type { SheetPayload } from "@/domain/types";
import {
  conflicts,
  rounds,
  sheetVersions,
  sheets,
  tournaments,
  type Tx,
  type TournamentRow,
} from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, actorTypeOf, recordAudit } from "./audit";
import { withTransaction, type Actor, type Queryable, type ServiceContext } from "./context";
import { loadGraph, settingsOf, type GraphAssignment, type TournamentGraph } from "./graph";
import { newId } from "./ids";

/** The actor stored on every simulated sheet version. */
export const SIMULATOR_ACTOR: Actor = { type: "demo", id: "simulator", name: "Simulator" };

/** The message every simulator entry point gives on a live tournament with real sheets. */
const SIMULATOR_OFF_MESSAGE =
  "Real sheets have been received by the tournament, so the simulator is switched off. Practise on a sandbox copy instead.";

// ---------------------------------------------------------------------------
// Guards and locks shared with the demo service
// ---------------------------------------------------------------------------

/**
 * Locks the tournament row for the rest of the transaction, so two
 * simulations (or a simulation and a draw save) cannot interleave, and
 * returns it. Throws `not_found` for an unknown id.
 */
export async function lockTournament(tx: Tx, tournamentId: string): Promise<TournamentRow> {
  const [row] = await tx
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .for("update");
  if (!row) throw errors.notFound("That tournament");
  return row;
}

/**
 * Refuses to simulate a live tournament once any sheet that is not
 * simulated exists. Sandbox and demo tournaments always pass.
 */
export async function assertSimulationAllowed(
  db: Queryable,
  tournament: Pick<TournamentRow, "id" | "kind">,
): Promise<void> {
  if (tournament.kind !== "live") return;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sheetVersions)
    .where(
      and(eq(sheetVersions.tournamentId, tournament.id), ne(sheetVersions.source, "simulated")),
    );
  if ((row?.count ?? 0) > 0) throw errors.validation(SIMULATOR_OFF_MESSAGE);
}

// ---------------------------------------------------------------------------
// Writing sheets
// ---------------------------------------------------------------------------

/**
 * Writes version 1 of a simulated sheet for an assignment that has none,
 * and records it in the history. The payload is validated against the
 * rubric first, exactly as a judge's would be.
 */
export async function insertSimulatedSheet(
  tx: Tx,
  ctx: ServiceContext,
  assignment: GraphAssignment,
  payload: SheetPayload,
  rubric: ReturnType<typeof settingsOf>["rubric"],
): Promise<{ versionId: string }> {
  const parsed = parseSheetPayload(payload, {
    rubric,
    speakerIds: assignment.identity.speakers.map((speaker) => speaker.id),
    teamIds: [assignment.identity.governmentTeamId, assignment.identity.oppositionTeamId],
  });
  if (!parsed.ok) {
    throw errors.internal(
      new Error(
        `Simulated sheet failed validation: ${parsed.errors.map((e) => e.message).join(" ")}`,
      ),
    );
  }
  const now = ctx.now();
  const versionId = newId();
  await tx.insert(sheetVersions).values({
    id: versionId,
    tournamentId: assignment.tournamentId,
    assignmentId: assignment.id,
    version: 1,
    scores: parsed.data.scores,
    sideFlipped: parsed.data.sideFlipped,
    roleSwaps: parsed.data.roleSwaps,
    source: "simulated",
    actorType: actorTypeOf(SIMULATOR_ACTOR),
    actorId: SIMULATOR_ACTOR.id,
    actorName: SIMULATOR_ACTOR.name,
    requestKey: `simulated:${assignment.id}:1`,
    receivedAt: now,
  });
  await tx.insert(sheets).values({
    tournamentId: assignment.tournamentId,
    assignmentId: assignment.id,
    version: 1,
    currentVersionId: versionId,
    updatedAt: now,
  });
  await recordAudit(tx, ctx, {
    tournamentId: assignment.tournamentId,
    action: AUDIT_ACTIONS.demoSimulated,
    entityType: "sheet",
    entityId: assignment.id,
    assignmentId: assignment.id,
    divisionCode: assignment.identity.divisionCode,
    after: { round: assignment.identity.round, judgeName: assignment.display.judgeName },
  });
  return { versionId };
}

export interface SimulationOptions {
  /** Every score follows from this; the same seed gives the same sheets. */
  seed: string;
  /** Chance that one score on a sheet is off by 18. Defaults to 0.04. */
  rogueChance?: number;
  /** Rogue scores placed on purpose, keyed by assignment id. */
  plantedRogues?: ReadonlyMap<string, PlantedRogue>;
}

/**
 * The sheet the simulator writes for one assignment under `options`. Pure
 * and deterministic, so a caller can see what a simulation will write
 * before it writes it (the demo uses this to plan its rogue scores).
 */
export function simulatedPayload(
  assignment: GraphAssignment,
  rubric: ReturnType<typeof settingsOf>["rubric"],
  options: SimulationOptions,
): SheetPayload {
  return simulateSheet({
    seed: options.seed,
    assignmentDisplay: assignment.display,
    rubric,
    judgeId: assignment.judgeId,
    rogueChance: options.rogueChance,
    plantRogue: options.plantedRogues?.get(assignment.id),
  });
}

/**
 * Simulates every one of `targets` that is live, unscored and in a
 * division whose results are not published, in the order given. Returns
 * the assignment ids written. The caller holds the tournament lock.
 */
export async function writeSimulatedSheets(
  tx: Tx,
  ctx: ServiceContext,
  graph: TournamentGraph,
  targets: readonly GraphAssignment[],
  options: SimulationOptions,
): Promise<string[]> {
  const { rubric } = settingsOf(graph.tournament);
  const scored = new Set(graph.sheets.map((sheet) => sheet.assignmentId));
  const finalized = new Map(graph.divisions.map((d) => [d.code, d.finalizedAt]));
  const written: string[] = [];
  for (const assignment of targets) {
    if (!assignment.live || scored.has(assignment.id)) continue;
    const finalizedAt = finalized.get(assignment.identity.divisionCode);
    if (finalizedAt) throw errors.divisionFinalized({ finalizedAt: finalizedAt.toISOString() });
    const payload = simulatedPayload(assignment, rubric, options);
    await insertSimulatedSheet(tx, ctx, assignment, payload, rubric);
    scored.add(assignment.id);
    written.push(assignment.id);
  }
  return written;
}

/** The seed the simulator uses when the caller gives none: the draw's, else the tournament id. */
function defaultSeed(tournament: Pick<TournamentRow, "id" | "drawSeed">, seed?: string): string {
  return seed?.trim() || tournament.drawSeed || tournament.id;
}

/** Live assignments on `debateIds`, in debate then seat order. */
function assignmentsOn(graph: TournamentGraph, debateIds: readonly string[]): GraphAssignment[] {
  const seatOf = new Map(graph.debateJudges.map((p) => [`${p.debateId}:${p.judgeId}`, p.seat]));
  const order = new Map(debateIds.map((id, index) => [id, index]));
  return graph.assignments
    .filter((a) => a.live && order.has(a.debateId))
    .sort(
      (a, b) =>
        (order.get(a.debateId) ?? 0) - (order.get(b.debateId) ?? 0) ||
        (seatOf.get(`${a.debateId}:${a.judgeId}`) ?? 0) -
          (seatOf.get(`${b.debateId}:${b.judgeId}`) ?? 0),
    );
}

/** The debates of one round in room order (division order first, then room sort order). */
export function debatesOfRound(graph: TournamentGraph, round: number) {
  const roomOrder = new Map(graph.rooms.map((room) => [room.id, room.sortOrder]));
  const divisionOrder = new Map(graph.divisions.map((d) => [d.code, d.sortOrder]));
  return graph.debates
    .filter((debate) => debate.round === round)
    .sort(
      (a, b) =>
        (divisionOrder.get(a.divisionCode) ?? 0) - (divisionOrder.get(b.divisionCode) ?? 0) ||
        (roomOrder.get(a.roomId) ?? 0) - (roomOrder.get(b.roomId) ?? 0),
    );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface SimulateRoomInput {
  tournamentId: string;
  round: number;
  roomId: string;
  seed?: string;
  rogueChance?: number;
}

export interface SimulateRoomResult {
  debateId: string;
  /** Assignment ids that received a simulated sheet. */
  written: string[];
  /** Live assignments on the debate that already had a sheet. */
  skipped: number;
}

/** One sheet per live, unscored assignment on the debate in that room and round. */
export async function simulateRoom(
  ctx: ServiceContext,
  input: SimulateRoomInput,
): Promise<SimulateRoomResult> {
  return withTransaction(ctx, async (tx) => {
    const tournament = await lockTournament(tx, input.tournamentId);
    await assertSimulationAllowed(tx, tournament);
    const graph = await loadGraph(tx, tournament.id);
    const debate = graph.debates.find((d) => d.round === input.round && d.roomId === input.roomId);
    if (!debate) throw errors.notFound("That room's debate in this round");
    const targets = assignmentsOn(graph, [debate.id]);
    const written = await writeSimulatedSheets(tx, ctx, graph, targets, {
      seed: defaultSeed(tournament, input.seed),
      rogueChance: input.rogueChance,
    });
    ctx.log.info(
      { tournamentId: tournament.id, debateId: debate.id, written: written.length },
      "Room simulated",
    );
    return { debateId: debate.id, written, skipped: targets.length - written.length };
  });
}

export interface SimulateRoundInput {
  tournamentId: string;
  round: number;
  seed?: string;
  rogueChance?: number;
  /** Leave this many sheets unwritten (the last ones in room order), so the board shows gaps. */
  leaveMissing?: number;
}

export interface SimulateRoundResult {
  round: number;
  written: string[];
  /** Assignment ids left without a sheet on purpose. */
  leftMissing: string[];
}

/** Every unscored sheet of the round, minus `leaveMissing` at the end. */
export async function simulateRound(
  ctx: ServiceContext,
  input: SimulateRoundInput,
): Promise<SimulateRoundResult> {
  return withTransaction(ctx, async (tx) => {
    const tournament = await lockTournament(tx, input.tournamentId);
    await assertSimulationAllowed(tx, tournament);
    const graph = await loadGraph(tx, tournament.id);
    const result = await simulateRoundIn(tx, ctx, graph, input.round, {
      seed: defaultSeed(tournament, input.seed),
      rogueChance: input.rogueChance,
      leaveMissing: input.leaveMissing,
    });
    ctx.log.info(
      { tournamentId: tournament.id, round: input.round, written: result.written.length },
      "Round simulated",
    );
    return result;
  });
}

async function simulateRoundIn(
  tx: Tx,
  ctx: ServiceContext,
  graph: TournamentGraph,
  round: number,
  options: SimulationOptions & { leaveMissing?: number },
): Promise<SimulateRoundResult> {
  if (!graph.rounds.some((r) => r.number === round)) throw errors.notFound("That round");
  const scored = new Set(graph.sheets.map((sheet) => sheet.assignmentId));
  const pending = assignmentsOn(
    graph,
    debatesOfRound(graph, round).map((debate) => debate.id),
  ).filter((assignment) => !scored.has(assignment.id));
  const keep = Math.max(0, Math.min(pending.length, Math.floor(options.leaveMissing ?? 0)));
  const targets = pending.slice(0, pending.length - keep);
  const written = await writeSimulatedSheets(tx, ctx, graph, targets, options);
  return { round, written, leftMissing: pending.slice(pending.length - keep).map((a) => a.id) };
}

export interface SkipAheadInput {
  tournamentId: string;
  /** A round number: every round before it is completed and it is opened. "results": every round. */
  to: number | "results";
  seed?: string;
  rogueChance?: number;
}

export interface SkipAheadResult {
  written: string[];
  /** The rounds that were simulated. */
  rounds: number[];
}

/**
 * Simulates every sheet in every round before `to` (or every round for
 * "results"), closes those rounds and opens the target round. The
 * tournament is marked running.
 */
export async function skipAhead(
  ctx: ServiceContext,
  input: SkipAheadInput,
): Promise<SkipAheadResult> {
  return withTransaction(ctx, async (tx) => {
    const tournament = await lockTournament(tx, input.tournamentId);
    await assertSimulationAllowed(tx, tournament);
    const graph = await loadGraph(tx, tournament.id);
    const numbers = graph.rounds.map((r) => r.number).sort((a, b) => a - b);
    if (input.to !== "results" && !numbers.includes(input.to)) throw errors.notFound("That round");
    const toSimulate = numbers.filter((n) => input.to === "results" || n < input.to);

    const written: string[] = [];
    const options = { seed: defaultSeed(tournament, input.seed), rogueChance: input.rogueChance };
    for (const round of toSimulate) {
      // Sheets written for an earlier round are in the graph already; reload is
      // not needed because `writeSimulatedSheets` never revisits a debate.
      const result = await simulateRoundIn(tx, ctx, graph, round, options);
      written.push(...result.written);
    }
    await setRoundStatuses(tx, tournament.id, toSimulate, input.to === "results" ? null : input.to);
    await tx
      .update(tournaments)
      .set({ status: "running", updatedAt: ctx.now() })
      .where(eq(tournaments.id, tournament.id));
    ctx.log.info(
      { tournamentId: tournament.id, to: input.to, written: written.length },
      "Skipped ahead",
    );
    return { written, rounds: toSimulate };
  });
}

/** Closes `closed` rounds and opens `open` (when given); other rounds are left as they are. */
export async function setRoundStatuses(
  tx: Tx,
  tournamentId: string,
  closed: readonly number[],
  open: number | null,
): Promise<void> {
  for (const number of closed) {
    await tx
      .update(rounds)
      .set({ status: "closed" })
      .where(and(eq(rounds.tournamentId, tournamentId), eq(rounds.number, number)));
  }
  if (open !== null) {
    await tx
      .update(rounds)
      .set({ status: "open" })
      .where(and(eq(rounds.tournamentId, tournamentId), eq(rounds.number, open)));
  }
}

export interface IntroduceConflictInput {
  tournamentId: string;
  assignmentId: string;
  seed?: string;
}

export interface IntroduceConflictResult {
  conflictId: string;
  assignmentId: string;
  currentVersion: number;
}

/**
 * Writes a second, differing version of a sheet as an open "two versions"
 * record, as if the judge's phone had sent an edit against an older
 * version. The sheet must exist; a sheet that already has two versions
 * waiting is refused so the demo stays readable.
 */
export async function introduceConflict(
  ctx: ServiceContext,
  input: IntroduceConflictInput,
): Promise<IntroduceConflictResult> {
  return withTransaction(ctx, async (tx) => {
    const tournament = await lockTournament(tx, input.tournamentId);
    await assertSimulationAllowed(tx, tournament);
    const graph = await loadGraph(tx, tournament.id);
    const assignment = graph.assignments.find((a) => a.id === input.assignmentId && a.live);
    if (!assignment) throw errors.notFound("That sheet");
    const sheet = graph.sheets.find((s) => s.assignmentId === assignment.id);
    if (!sheet) {
      throw errors.validation("Simulate this sheet first, then introduce a second version.");
    }
    if (graph.conflicts.some((c) => c.assignmentId === assignment.id && c.status === "open")) {
      throw errors.validation("This sheet already has two versions waiting for the organiser.");
    }
    const { rubric } = settingsOf(graph.tournament);
    const incoming = differingPayload(
      sheet,
      assignment,
      rubric,
      defaultSeed(tournament, input.seed),
    );
    const conflictId = newId();
    await tx.insert(conflicts).values({
      id: conflictId,
      tournamentId: tournament.id,
      assignmentId: assignment.id,
      judgeId: assignment.judgeId,
      requestId: `simulated-conflict:${conflictId}`,
      kind: "version",
      incoming,
      baseVersion: sheet.version - 1,
      currentVersion: sheet.version,
      status: "open",
      createdAt: ctx.now(),
    });
    await recordAudit(tx, ctx, {
      tournamentId: tournament.id,
      action: AUDIT_ACTIONS.demoSimulated,
      entityType: "conflict",
      entityId: conflictId,
      assignmentId: assignment.id,
      divisionCode: assignment.identity.divisionCode,
      after: { kind: "version", currentVersion: sheet.version },
    });
    return { conflictId, assignmentId: assignment.id, currentVersion: sheet.version };
  });
}

/**
 * A payload that differs from the current sheet in at least one Overall
 * score: a fresh simulation from another seed, nudged when it happens to
 * agree with the current version.
 */
function differingPayload(
  sheet: TournamentGraph["sheets"][number],
  assignment: GraphAssignment,
  rubric: ReturnType<typeof settingsOf>["rubric"],
  seed: string,
): SheetPayload {
  const payload = simulateSheet({
    seed: `${seed}|conflict`,
    assignmentDisplay: assignment.display,
    rubric,
    judgeId: assignment.judgeId,
    rogueChance: 0,
    sideFlipped: sheet.sideFlipped,
    roleSwaps: sheet.roleSwaps,
  });
  const firstId = assignment.identity.speakers[0]?.id;
  const same = Object.entries(payload.scores).every(
    ([id, score]) => sheet.scores[id]?.overall === score.overall,
  );
  if (same && firstId && payload.scores[firstId]) {
    const current = payload.scores[firstId].overall;
    payload.scores[firstId].overall = current >= rubric.overallMax - 5 ? current - 5 : current + 5;
  }
  return payload;
}
