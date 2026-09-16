/**
 * Demo and sandbox tournaments: invented data at a chosen stage of the day.
 *
 * `createDemoTournament` builds a tournament that is "about to start",
 * "teams loaded", "drawn", "half-way through round 1" or "complete". For
 * kind `demo` it also creates a throwaway organisation and organiser, and
 * marks the tournament to expire after 24 hours (see `cleanup.ts`). It
 * ends by storing a creation snapshot, which is what `resetSandbox`
 * returns to.
 *
 * `generateSampleInto` is the dashboard button: it fills an empty setup
 * with sample teams, judges and rooms.
 *
 * Two helpers here stand in for services that other tracks are writing at
 * the same time and should be swapped by the integrator once both exist:
 * `persistDraw` for `saveDraw` (draw service) and, through `simulate.ts`,
 * `insertSimulatedSheet` for `receiveSheet` (sheets service). Both are
 * written for fresh tournaments and have no protection logic for draws that
 * already carry sheets.
 */
import { and, eq, sql } from "drizzle-orm";

import { createRandom, generateDraw, generateSeed } from "@/domain/draw";
import { generateSample, type PlantedRogue } from "@/domain/sample";
import { deriveAssignments, hasBlockers, scheduleIssues } from "@/domain/schedule";
import {
  WORKBOOK_POLICY,
  computeDivisionResults,
  type DivisionInput,
  type ScoreSource,
} from "@/domain/scoring";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { Debate, SheetPayload, TournamentSettings } from "@/domain/types";
import {
  assignments,
  debateJudges,
  debateTeams,
  debates,
  divisions,
  judges,
  memberships,
  organisations,
  rooms,
  rounds,
  setupRevisions,
  speakers,
  teams,
  tournaments,
  users,
  type Tx,
} from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { CREATION_SNAPSHOT_LABEL, DEMO_LIFETIME_MS, insertTournamentRow } from "./backup";
import { withTransaction, type ServiceContext } from "./context";
import { publishDraw } from "./draw";
import {
  loadGraph,
  settingsOf,
  toDivisionInput,
  toSchedule,
  type GraphAssignment,
  type TournamentGraph,
} from "./graph";
import { crockfordCode, fingerprintOf, hashToken, newId, randomToken } from "./ids";
import {
  assertSimulationAllowed,
  debatesOfRound,
  lockTournament,
  setRoundStatuses,
  simulatedPayload,
  writeSimulatedSheets,
} from "./simulate";
import { snapshotTournament } from "./snapshots";

/** Defined in `backup.ts` (an import as a demo needs them too); re-exported for callers. */
export { CREATION_SNAPSHOT_LABEL, DEMO_LIFETIME_MS } from "./backup";
/** Throwaway organisations for per-visitor demos carry this slug prefix. */
export const DEMO_ORGANISATION_SLUG_PREFIX = "demo-";
/** Synthetic organisers for per-visitor demos have addresses in this domain. */
export const DEMO_USER_EMAIL_DOMAIN = "demo.invalid";

/**
 * The sample roster for demos: 12 Open and 8 Novice teams in 10 rooms,
 * three judges each. Three per room is what the workbook rule needs before
 * a rogue score can be set aside at all (see `src/domain/sample/simulate.ts`),
 * and it matches the default panel size.
 */
export const DEMO_ROSTER = { open: 12, novice: 8, rooms: 10, judgesPerRoom: 3 } as const;

export type DemoStage = "about-to-start" | "teams-loaded" | "drawn" | "round1-half" | "complete";

const STAGE_ORDER: readonly DemoStage[] = [
  "about-to-start",
  "teams-loaded",
  "drawn",
  "round1-half",
  "complete",
];

/** True when `stage` is at or past `target` in the order of the day. */
function reaches(stage: DemoStage, target: DemoStage): boolean {
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(target);
}

export interface CreateDemoInput {
  /** Required for kind `sandbox`; ignored for kind `demo`, which gets its own organisation. */
  organisationId?: string;
  kind: "demo" | "sandbox";
  name?: string;
  /** Seeds the roster, the draw and the simulated scores. Defaults to "demo". */
  seed?: string;
  stage: DemoStage;
}

export interface CreateDemoResult {
  tournamentId: string;
  organisationId: string;
  /** The synthetic organiser, for kind `demo` only. */
  userId?: string;
  slug: string;
  joinCode: string;
  seed: string;
  /** The draw's visible seed, once the stage includes a draw. */
  drawSeed: string | null;
  /** The creation snapshot, which `resetSandbox` restores. */
  snapshotId: string;
}

/** Builds the whole tournament in one transaction; see the file comment. */
export async function createDemoTournament(
  ctx: ServiceContext,
  input: CreateDemoInput,
): Promise<CreateDemoResult> {
  const seed = input.seed?.trim() || "demo";
  const settings: TournamentSettings = {
    ...DEFAULT_SETTINGS,
    judgesPerRoom: DEMO_ROSTER.judgesPerRoom,
  };

  return withTransaction(ctx, async (tx) => {
    const now = ctx.now();
    const owner = await resolveOwner(tx, ctx, input);
    const tag = crockfordCode(8).toLowerCase();
    const tournamentId = newId();
    const slug = `${input.kind}-${tag}`;
    const code = await insertTournamentRow(tx, {
      id: tournamentId,
      organisationId: owner.organisationId,
      slug,
      name: input.name?.trim() || `Sample Inter-Schools Debate ${now.getFullYear()}`,
      kind: input.kind,
      status: "setup",
      settings,
      scoringPolicy: { ...WORKBOOK_POLICY },
      demoExpiresAt: input.kind === "demo" ? new Date(now.getTime() + DEMO_LIFETIME_MS) : null,
      createdAt: now,
      updatedAt: now,
    });
    await insertDivisionsAndRounds(tx, tournamentId, settings);
    await recordAudit(tx, ctx, {
      tournamentId,
      action: AUDIT_ACTIONS.demoCreated,
      entityType: "tournament",
      entityId: tournamentId,
      after: { kind: input.kind, stage: input.stage, seed },
    });

    let drawSeed: string | null = null;
    if (reaches(input.stage, "teams-loaded")) {
      await seedRoster(tx, ctx, tournamentId, settings, { seed, ...DEMO_ROSTER });
    }
    if (reaches(input.stage, "drawn")) {
      drawSeed = generateSeed({ year: now.getFullYear(), random: createRandom(`${seed}|draw`) });
      const schedule = toSchedule(await loadGraph(tx, tournamentId));
      const draw = generateDraw({
        schedule,
        divisionCodes: settings.divisions.map((division) => division.code),
        seed: drawSeed,
        method: "random",
      });
      if (!draw.ok) throw errors.internal(new Error(`Demo draw failed: ${draw.error.message}`));
      const saved = await persistDraw(tx, ctx, tournamentId, draw.debates, { seed: draw.seed });
      await publishDraw(tx, ctx, tournamentId, { baseRevision: saved.revision });
    }
    if (input.stage === "round1-half") {
      const graph = await loadGraph(tx, tournamentId);
      const targets = halfOfRoundOne(graph);
      await writeSimulatedSheets(tx, ctx, graph, targets, { seed });
      await setRoundStatuses(tx, tournamentId, [], 1);
      await tx
        .update(tournaments)
        .set({ status: "running" })
        .where(eq(tournaments.id, tournamentId));
    }
    if (input.stage === "complete") {
      const graph = await loadGraph(tx, tournamentId);
      await writeSimulatedSheets(tx, ctx, graph, graph.assignments, {
        seed,
        plantedRogues: planRogues(ctx, graph, seed),
      });
      await setRoundStatuses(
        tx,
        tournamentId,
        graph.rounds.map((round) => round.number),
        null,
      );
      await tx
        .update(tournaments)
        .set({ status: "running" })
        .where(eq(tournaments.id, tournamentId));
    }

    const snapshot = await snapshotTournament(tx, ctx, tournamentId, "manual", {
      label: CREATION_SNAPSHOT_LABEL,
    });
    ctx.log.info(
      { tournamentId, kind: input.kind, stage: input.stage, snapshotId: snapshot.id },
      "Demo tournament created",
    );
    return {
      tournamentId,
      organisationId: owner.organisationId,
      ...(owner.userId ? { userId: owner.userId } : {}),
      slug,
      joinCode: code,
      seed,
      drawSeed,
      snapshotId: snapshot.id,
    };
  });
}

/**
 * The organisation that owns the new tournament. A demo gets a throwaway
 * organisation and a synthetic organiser with no password; a sandbox goes
 * into an existing organisation, which must be given.
 */
async function resolveOwner(
  tx: Tx,
  ctx: ServiceContext,
  input: CreateDemoInput,
): Promise<{ organisationId: string; userId?: string }> {
  if (input.kind === "sandbox") {
    if (!input.organisationId) {
      throw errors.validation("Choose the organisation the sandbox belongs to.");
    }
    const [organisation] = await tx
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .limit(1);
    if (!organisation) throw errors.notFound("That organisation");
    return { organisationId: organisation.id };
  }
  const tag = crockfordCode(10).toLowerCase();
  const now = ctx.now();
  const [organisation] = await tx
    .insert(organisations)
    .values({
      slug: `${DEMO_ORGANISATION_SLUG_PREFIX}${tag}`,
      name: "Demo organisation",
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: organisations.id });
  const [user] = await tx
    .insert(users)
    .values({
      email: `demo-${tag}@${DEMO_USER_EMAIL_DOMAIN}`,
      name: "Demo organiser",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: users.id });
  await tx.insert(memberships).values({
    organisationId: organisation.id,
    userId: user.id,
    role: "owner",
    createdAt: now,
  });
  return { organisationId: organisation.id, userId: user.id };
}

async function insertDivisionsAndRounds(
  tx: Tx,
  tournamentId: string,
  settings: TournamentSettings,
): Promise<void> {
  await tx.insert(divisions).values(
    settings.divisions.map((division, index) => ({
      tournamentId,
      code: division.code,
      name: division.name,
      sortOrder: index + 1,
    })),
  );
  await tx.insert(rounds).values(
    settings.rounds.map((round) => ({
      tournamentId,
      number: round.number,
      format: round.format,
      sidesDecided: round.sidesDecided,
    })),
  );
}

// ---------------------------------------------------------------------------
// Sample roster
// ---------------------------------------------------------------------------

export interface SampleRosterOptions {
  seed?: string;
  /** Teams in the first division. */
  open?: number;
  /** Teams in the second division; ignored when the tournament has only one. */
  novice?: number;
  rooms?: number;
  judgesPerRoom?: number;
}

export interface SampleRosterCounts {
  teams: number;
  debaters: number;
  judges: number;
  rooms: number;
}

/**
 * The dashboard button. Fills an empty setup with invented teams, judges
 * and rooms, and refuses when any of the three already has rows so a real
 * roster can never be mixed with a sample one.
 */
export async function generateSampleInto(
  ctx: ServiceContext,
  tournamentId: string,
  options: SampleRosterOptions = {},
): Promise<SampleRosterCounts> {
  return withTransaction(ctx, async (tx) => {
    const tournament = await lockTournament(tx, tournamentId);
    if (tournament.kind === "live" && tournament.status !== "setup") {
      throw errors.validation(
        "Sample data can only be added to a live tournament before it starts.",
      );
    }
    await assertSimulationAllowed(tx, tournament);
    const graph = await loadGraph(tx, tournamentId);
    if (graph.teams.length || graph.judges.length || graph.rooms.length) {
      throw errors.validation(
        "This tournament already has teams, judges or rooms. Sample data can only be added to an empty setup.",
      );
    }
    const settings = toSchedule(graph).settings;
    const counts = await seedRoster(tx, ctx, tournamentId, settings, options);
    ctx.log.info({ tournamentId, ...counts }, "Sample roster generated");
    return counts;
  });
}

/**
 * Inserts a `generateSample` roster under the tournament with fresh uuids:
 * rooms, teams with two debaters each, and judges with a home room, a
 * six-symbol code and a join token. Records one history row per step.
 */
export async function seedRoster(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  settings: TournamentSettings,
  options: SampleRosterOptions,
): Promise<SampleRosterCounts> {
  const [first, second] = settings.divisions;
  const roster = generateSample({
    seed: options.seed ?? "demo",
    open: options.open ?? DEMO_ROSTER.open,
    novice: second ? (options.novice ?? DEMO_ROSTER.novice) : 0,
    rooms: options.rooms ?? DEMO_ROSTER.rooms,
    judgesPerRoom: options.judgesPerRoom ?? settings.judgesPerRoom,
    openCode: first.code,
    noviceCode: second?.code ?? first.code,
  });
  const now = ctx.now();
  const roomIds = new Map(roster.rooms.map((room) => [room.id, newId()]));
  const teamIds = new Map(roster.teams.map((team) => [team.id, newId()]));

  await tx.insert(rooms).values(
    roster.rooms.map((room) => ({
      id: roomIds.get(room.id),
      tournamentId,
      name: room.name,
      sortOrder: room.sortOrder,
      createdAt: now,
    })),
  );
  await tx.insert(teams).values(
    roster.teams.map((team) => ({
      id: teamIds.get(team.id),
      tournamentId,
      divisionCode: team.divisionCode,
      code: team.code,
      name: team.name,
      school: team.school,
      seed: team.seed ?? null,
      status: team.status,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const debaterRows = roster.teams.flatMap((team) =>
    team.speakers.map((speaker) => ({
      tournamentId,
      teamId: teamIds.get(team.id) as string,
      position: speaker.position,
      name: speaker.name,
      createdAt: now,
    })),
  );
  await tx.insert(speakers).values(debaterRows);
  const usedCodes = new Set<string>();
  await tx.insert(judges).values(
    roster.judges.map((judge) => ({
      tournamentId,
      name: judge.name,
      code: uniqueJudgeCode(usedCodes),
      joinTokenHash: hashToken(randomToken()),
      homeRoomId: judge.homeRoomId ? (roomIds.get(judge.homeRoomId) ?? null) : null,
      status: judge.status,
      createdAt: now,
      updatedAt: now,
    })),
  );

  const counts: SampleRosterCounts = {
    teams: roster.teams.length,
    debaters: debaterRows.length,
    judges: roster.judges.length,
    rooms: roster.rooms.length,
  };
  const entry = { tournamentId, entityType: "tournament", entityId: tournamentId };
  await recordAudit(tx, ctx, {
    ...entry,
    action: AUDIT_ACTIONS.roomsCreated,
    after: { sample: true, rooms: counts.rooms },
  });
  await recordAudit(tx, ctx, {
    ...entry,
    action: AUDIT_ACTIONS.teamsImported,
    after: { sample: true, teams: counts.teams, debaters: counts.debaters },
  });
  await recordAudit(tx, ctx, {
    ...entry,
    action: AUDIT_ACTIONS.judgesCreated,
    after: { sample: true, judges: counts.judges },
  });
  return counts;
}

/** A six-symbol Crockford code not yet used in this batch (codes are case-insensitive). */
function uniqueJudgeCode(used: Set<string>): string {
  let code = crockfordCode(6);
  while (used.has(code)) code = crockfordCode(6);
  used.add(code);
  return code;
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

export interface PersistDrawOptions {
  /** The seed that reproduces the draw; shown to the organiser. */
  seed: string;
}

export interface PersistDrawResult {
  revision: number;
  debates: number;
  assignments: number;
}

/**
 * Stores a generated draw for a tournament that has none: debates with
 * their sides and panels, then the live assignments derived from the
 * schedule, a setup revision and a history row. Every debate id from the
 * generator is replaced by a uuid. Not for editing an existing draw.
 */
export async function persistDraw(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  drawn: readonly Debate[],
  options: PersistDrawOptions,
): Promise<PersistDrawResult> {
  const before = await loadGraph(tx, tournamentId);
  if (before.debates.length) {
    throw errors.validation(
      "This tournament already has a draw. Change it on the draw page instead.",
    );
  }
  const candidate = { ...toSchedule(before), debates: [...drawn] };
  const issues = scheduleIssues(candidate, { requireComplete: true });
  if (hasBlockers(issues)) {
    throw errors.validation(issues.find((issue) => issue.severity === "blocker")?.message, {
      issues: issues.map((issue) => ({ path: issue.code, message: issue.message })),
    });
  }

  const now = ctx.now();
  const debateIds = new Map(drawn.map((debate) => [debate.id, newId()]));
  await tx.insert(debates).values(
    drawn.map((debate) => ({
      id: debateIds.get(debate.id),
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
  await tx.insert(debateTeams).values(
    drawn.flatMap((debate) => {
      const debateId = debateIds.get(debate.id) as string;
      return [
        {
          tournamentId,
          debateId,
          round: debate.round,
          teamId: debate.governmentTeamId,
          side: "government" as const,
        },
        {
          tournamentId,
          debateId,
          round: debate.round,
          teamId: debate.oppositionTeamId,
          side: "opposition" as const,
        },
      ];
    }),
  );
  const panelRows = drawn.flatMap((debate) =>
    debate.judgeIds.map((judgeId, index) => ({
      tournamentId,
      debateId: debateIds.get(debate.id) as string,
      round: debate.round,
      judgeId,
      seat: index + 1,
    })),
  );
  if (panelRows.length) await tx.insert(debateJudges).values(panelRows);

  const revision = before.tournament.revision + 1;
  await tx
    .update(tournaments)
    .set({ revision, drawSeed: options.seed, updatedAt: now })
    .where(eq(tournaments.id, tournamentId));

  const schedule = toSchedule(await loadGraph(tx, tournamentId));
  const derived = deriveAssignments(schedule, []);
  if (derived.skipped.length) {
    throw errors.internal(new Error(`Draw left slots unresolved: ${derived.skipped[0].reason}`));
  }
  if (derived.assignments.length) {
    await tx.insert(assignments).values(
      derived.assignments.map((assignment) => ({
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
  await tx.insert(setupRevisions).values({
    tournamentId,
    revision,
    snapshot: schedule,
    author: ctx.actor.name,
    at: now,
  });
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.drawSaved,
    entityType: "tournament",
    entityId: tournamentId,
    after: {
      seed: options.seed,
      revision,
      debates: drawn.length,
      assignments: derived.assignments.length,
      warnings: issues.map((issue) => issue.message),
    },
  });
  return { revision, debates: drawn.length, assignments: derived.assignments.length };
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

/**
 * The live assignments on the first half of each division's round-1 rooms,
 * so both divisions show progress on the live board.
 */
function halfOfRoundOne(graph: TournamentGraph): GraphAssignment[] {
  const chosen = new Set<string>();
  for (const division of graph.divisions) {
    const inDivision = debatesOfRound(graph, 1).filter((d) => d.divisionCode === division.code);
    for (const debate of inDivision.slice(0, Math.ceil(inDivision.length / 2)))
      chosen.add(debate.id);
  }
  return graph.assignments.filter(
    (assignment) => assignment.live && chosen.has(assignment.debateId),
  );
}

// ---------------------------------------------------------------------------
// Planting one set-aside score per division

/** Slips of the pen to try, smallest first. 18 is the simulator's usual typo. */
const ROGUE_DELTAS: readonly number[] = [18, 24, 30];
/** How many debaters per division to try before giving up on a visible set-aside score. */
const ROGUE_CANDIDATES = 8;

/**
 * One rogue score per division, chosen so that the results page really has
 * a set-aside score to explain. Whether a slip is set aside depends on the
 * debater's other scores (average ± 2 × spread over all rounds), so the
 * plan is checked rather than hoped for: every sheet is simulated in memory
 * first (the simulator is deterministic, so this is exactly what will be
 * written), then debaters are tried from the tightest spread outwards,
 * with a growing slip, until the workbook policy sets the planted score
 * aside. A division where nothing works gets the first candidate anyway
 * and a warning in the log.
 */
function planRogues(
  ctx: ServiceContext,
  graph: TournamentGraph,
  seed: string,
): Map<string, PlantedRogue> {
  const { rubric } = settingsOf(graph.tournament);
  const live = graph.assignments.filter((assignment) => assignment.live);
  const planned = new Map(
    live.map((assignment) => [assignment.id, simulatedPayload(assignment, rubric, { seed })]),
  );
  const rogues = new Map<string, PlantedRogue>();
  for (const division of graph.divisions) {
    const input = plannedDivisionInput(graph, division.code, live, planned);
    const candidates = rogueCandidates(input, live).slice(0, ROGUE_CANDIDATES);
    if (!candidates.length) continue;
    const chosen = candidates
      .flatMap((slot) => ROGUE_DELTAS.map((delta) => ({ ...slot, delta })))
      .find((plan) => {
        const assignment = live.find((a) => a.id === plan.assignmentId);
        if (!assignment) return false;
        const withPlant = simulatedPayload(assignment, rubric, {
          seed,
          plantedRogues: new Map([[plan.assignmentId, plan]]),
        });
        const scores = [
          ...input.scores.filter((score) => score.assignmentId !== plan.assignmentId),
          ...plannedScores(assignment, withPlant),
        ];
        return isSetAside({ ...input, scores }, plan);
      });
    const plan = chosen ?? candidates[0];
    if (!chosen) {
      ctx.log.warn(
        { tournamentId: graph.tournament.id, divisionCode: division.code },
        "No planted rogue score would be set aside in this division",
      );
    }
    rogues.set(plan.assignmentId, { speakerId: plan.speakerId, delta: plan.delta });
  }
  return rogues;
}

interface RoguePlan {
  assignmentId: string;
  speakerId: string;
  delta?: number;
}

/** The division as the results page will see it once every planned sheet is written. */
function plannedDivisionInput(
  graph: TournamentGraph,
  divisionCode: string,
  live: readonly GraphAssignment[],
  planned: ReadonlyMap<string, SheetPayload>,
): DivisionInput {
  const base = toDivisionInput(graph, divisionCode, WORKBOOK_POLICY);
  const expected = new Set(base.expectedSheets.map((sheet) => sheet.assignmentId));
  const scores = live
    .filter((assignment) => expected.has(assignment.id))
    .flatMap((assignment) => plannedScores(assignment, planned.get(assignment.id)));
  return {
    ...base,
    expectedSheets: base.expectedSheets.map((sheet) => ({ ...sheet, received: true })),
    scores,
  };
}

/** The score sources one planned sheet contributes, as `toDivisionInput` would build them. */
function plannedScores(assignment: GraphAssignment, payload?: SheetPayload): ScoreSource[] {
  if (!payload) return [];
  return assignment.identity.speakers.flatMap((speaker) => {
    const overall = payload.scores[speaker.id]?.overall;
    if (typeof overall !== "number") return [];
    return [
      {
        assignmentId: assignment.id,
        judgeId: assignment.judgeId,
        judgeName: assignment.display.judgeName,
        round: assignment.identity.round,
        debaterId: speaker.id,
        value: overall,
        sheetVersion: 1,
        source: "simulation" as const,
      },
    ];
  });
}

/**
 * Where a rogue could go: each debater's first-round sheet from the first
 * judge on the panel, debaters with the tightest spread of planned scores
 * first (the easier a slip is to spot, the surer it is set aside).
 */
function rogueCandidates(input: DivisionInput, live: readonly GraphAssignment[]): RoguePlan[] {
  const byDebater = new Map<string, number[]>();
  for (const score of input.scores) {
    byDebater.set(score.debaterId, [...(byDebater.get(score.debaterId) ?? []), score.value]);
  }
  const spreadOf = (id: string) => sampleSpread(byDebater.get(id) ?? []);
  return input.debaters
    .map((debater) => ({ debater, spread: spreadOf(debater.id) }))
    .sort((a, b) => a.spread - b.spread || a.debater.name.localeCompare(b.debater.name))
    .flatMap(({ debater }) => {
      const sheet = live
        .filter((a) => a.identity.speakers.some((speaker) => speaker.id === debater.id))
        .sort((a, b) => a.identity.round - b.identity.round)[0];
      return sheet ? [{ assignmentId: sheet.id, speakerId: debater.id }] : [];
    });
}

/** Sample standard deviation; zero with fewer than two values. */
function sampleSpread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

/** True when the workbook policy sets the planted score aside. */
function isSetAside(input: DivisionInput, plan: RoguePlan): boolean {
  const results = computeDivisionResults(input);
  const debater = results.debaters.find((row) => row.id === plan.speakerId);
  return (
    debater?.rounds.some((round) =>
      round.sources.some(
        (source) => source.assignmentId === plan.assignmentId && source.status === "lopped",
      ),
    ) ?? false
  );
}

/** True when the tournament has no teams, judges or rooms yet. Exported for the dashboard. */
export async function isSetupEmpty(tx: Tx, tournamentId: string): Promise<boolean> {
  const count = async (table: typeof teams | typeof judges | typeof rooms) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.tournamentId, tournamentId)));
    return row?.count ?? 0;
  };
  return (await count(teams)) === 0 && (await count(judges)) === 0 && (await count(rooms)) === 0;
}
