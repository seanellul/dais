/**
 * The dashboard checklist: Teams, Judges, Rooms & panels, Draw, one step per
 * round, Results. Every step's state is computed from the data (the domain
 * readiness rules plus counts from the graph); an organiser can mark a step
 * done or skipped anyway, with a reason, which is stored as an override.
 *
 * States: not-started (nothing entered), in-progress (some data, work left),
 * needs-attention (a rule is broken; the issues say which), ready (the next
 * action can be taken now), done.
 */
import { and, eq, isNull } from "drizzle-orm";

import { readiness, validateSchedule, type ScheduleIssue } from "@/domain/schedule";
import type { Schedule } from "@/domain/types";
import { checklistOverrides, type ChecklistOverrideRow, type Tx } from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import type { Queryable, ServiceContext } from "./context";
import { drawStatus, type DrawStatus } from "./draw";
import { loadGraph, toSchedule, type TournamentGraph } from "./graph";

export type ChecklistState = "not-started" | "in-progress" | "needs-attention" | "ready" | "done";
export type ChecklistOverrideState = ChecklistOverrideRow["state"];

export interface ChecklistOverride {
  state: ChecklistOverrideState;
  reason: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface ChecklistStep {
  /** "teams" | "judges" | "rooms" | "draw" | "round1".. | "results". */
  key: string;
  title: string;
  state: ChecklistState;
  /** Plain-English counts, e.g. "12 teams in Open, 8 in Novice". */
  summary: string;
  issues: ScheduleIssue[];
  override?: ChecklistOverride;
}

export interface ChecklistStatus {
  steps: ChecklistStep[];
  /** The first step that is not done: where the accent button points. */
  next: string | null;
}

const FIXED_STEPS = ["teams", "judges", "rooms", "draw"] as const;

/** The step keys for a tournament, in order. */
export function checklistKeys(schedule: Schedule): string[] {
  const roundKeys = [...schedule.settings.rounds]
    .sort((a, b) => a.number - b.number)
    .map((round) => `round${round.number}`);
  return [...FIXED_STEPS, ...roundKeys, "results"];
}

// ---------------------------------------------------------------------------
// Status

export async function checklistStatus(
  db: Queryable,
  tournamentId: string,
): Promise<ChecklistStatus> {
  const graph = await loadGraph(db, tournamentId);
  const schedule = toSchedule(graph);
  const [draw, overrides] = await Promise.all([
    drawStatus(db, tournamentId),
    db
      .select()
      .from(checklistOverrides)
      .where(
        and(
          eq(checklistOverrides.tournamentId, tournamentId),
          isNull(checklistOverrides.revokedAt),
        ),
      ),
  ]);
  const issuesByDivision = schedule.settings.divisions.map((division) => ({
    division,
    issues: readiness(schedule, division.code).map((issue) => ({
      ...issue,
      message: issue.divisionCode ? `${division.name}: ${issue.message}` : issue.message,
    })),
  }));
  const issuesFor = (tab: ScheduleIssue["tab"]) =>
    dedupe(issuesByDivision.flatMap(({ issues }) => issues.filter((issue) => issue.tab === tab)));

  const computed: ChecklistStep[] = [
    teamsStep(schedule, issuesFor("teams")),
    judgesStep(schedule, issuesFor("judges")),
    roomsStep(schedule, issuesFor("rooms")),
    drawStep(schedule, draw, issuesFor("draw")),
    ...roundSteps(graph, schedule, draw),
    resultsStep(graph, schedule),
  ];
  const steps = computed.map((step) => applyOverride(step, overrides));
  const next = steps.find((step) => step.state !== "done")?.key ?? null;
  return { steps, next };
}

function dedupe(issues: ScheduleIssue[]): ScheduleIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.message)) return false;
    seen.add(issue.message);
    return true;
  });
}

function stateFromIssues(issues: ScheduleIssue[], whenClean: ChecklistState): ChecklistState {
  if (issues.some((issue) => issue.severity === "blocker")) return "needs-attention";
  if (issues.length > 0) return "in-progress";
  return whenClean;
}

function activeTeams(schedule: Schedule, divisionCode?: string) {
  return schedule.teams.filter(
    (team) =>
      team.status === "active" &&
      (divisionCode === undefined || team.divisionCode === divisionCode),
  );
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function teamsStep(schedule: Schedule, issues: ScheduleIssue[]): ChecklistStep {
  const total = activeTeams(schedule).length;
  const perDivision = schedule.settings.divisions
    .map((division, index) =>
      index === 0
        ? `${plural(activeTeams(schedule, division.code).length, "team")} in ${division.name}`
        : `${activeTeams(schedule, division.code).length} in ${division.name}`,
    )
    .join(", ");
  return {
    key: "teams",
    title: "Teams",
    state: total === 0 ? "not-started" : stateFromIssues(issues, "done"),
    summary: total === 0 ? "No teams yet. Paste the team list to begin." : perDivision,
    issues,
  };
}

function judgesStep(schedule: Schedule, issues: ScheduleIssue[]): ChecklistStep {
  const active = schedule.judges.filter((judge) => judge.status === "active");
  const fixed = schedule.settings.panelMode === "fixed-room";
  const unallocated = active.filter((judge) => !judge.homeRoomId).length;
  const summary =
    active.length === 0
      ? "No judges yet."
      : fixed && unallocated > 0
        ? `${plural(active.length, "judge")}, ${unallocated} with no room yet`
        : plural(active.length, "judge");
  return {
    key: "judges",
    title: "Judges",
    state: active.length === 0 ? "not-started" : stateFromIssues(issues, "done"),
    summary,
    issues,
  };
}

function roomsStep(schedule: Schedule, issues: ScheduleIssue[]): ChecklistStep {
  const needed = schedule.settings.divisions.reduce(
    (sum, division) => sum + Math.ceil(activeTeams(schedule, division.code).length / 2),
    0,
  );
  const listed = schedule.rooms.length;
  const short = needed - listed;
  const summary =
    listed === 0
      ? needed > 0
        ? `No rooms yet; each round needs ${needed}.`
        : "No rooms yet."
      : short > 0
        ? `${plural(listed, "room")}; each round needs ${needed}, ${short} short`
        : `${plural(listed, "room")}; each round needs ${needed}`;
  let state: ChecklistState;
  if (listed === 0) state = "not-started";
  else if (short > 0) state = "needs-attention";
  else state = stateFromIssues(issues, "done");
  return { key: "rooms", title: "Rooms & panels", state, summary, issues };
}

function drawStep(schedule: Schedule, draw: DrawStatus, issues: ScheduleIssue[]): ChecklistStep {
  const debates = schedule.debates.length;
  const rounds = schedule.settings.rounds.length;
  const complete = validateSchedule(schedule, { requireComplete: true }).ok;
  let state: ChecklistState;
  let summary: string;
  if (debates === 0) {
    const inputsReady =
      activeTeams(schedule).length > 0 && schedule.judges.length > 0 && schedule.rooms.length > 0;
    state = inputsReady ? "ready" : "not-started";
    summary = inputsReady ? "Ready to generate the draw." : "Add teams, judges and rooms first.";
  } else if (issues.some((issue) => issue.severity === "blocker") || !complete) {
    state = "needs-attention";
    summary = `${plural(debates, "debate")} over ${plural(rounds, "round")}; the draw checks need attention.`;
  } else if (draw.status === "published") {
    state = "done";
    summary = `Draw published: ${plural(debates, "debate")} over ${plural(rounds, "round")}.`;
  } else if (draw.status === "changed") {
    state = "in-progress";
    summary = `The draw changed since it was published; publish it again.`;
  } else {
    state = "ready";
    summary = `${plural(debates, "debate")} over ${plural(rounds, "round")}; ready to publish.`;
  }
  return { key: "draw", title: "Draw", state, summary, issues };
}

/** One step per round, in number order. A round is ready to open once the one before it is closed. */
function roundSteps(graph: TournamentGraph, schedule: Schedule, draw: DrawStatus): ChecklistStep[] {
  const numbers = schedule.settings.rounds.map((round) => round.number).sort((a, b) => a - b);
  return numbers.map((number, index) => {
    const previous =
      index === 0 ? undefined : graph.rounds.find((row) => row.number === numbers[index - 1]);
    const previousClosed = index === 0 || previous?.status === "closed";
    return roundStep(graph, schedule, number, draw, previousClosed);
  });
}

function roundStep(
  graph: TournamentGraph,
  schedule: Schedule,
  number: number,
  draw: DrawStatus,
  previousClosed: boolean,
): ChecklistStep {
  const key = `round${number}`;
  const title = `Round ${number}`;
  const round = graph.rounds.find((row) => row.number === number);
  const debateIds = new Set(
    schedule.debates.filter((debate) => debate.round === number).map((debate) => debate.id),
  );
  const expected = graph.assignments.filter((row) => row.live && debateIds.has(row.debateId));
  const sheetIds = new Set(graph.sheets.map((sheet) => sheet.assignmentId));
  const received = expected.filter((row) => sheetIds.has(row.id)).length;
  const missing = expected.length - received;
  const twoVersions = graph.conflicts.filter(
    (conflict) =>
      conflict.status === "open" && expected.some((row) => row.id === conflict.assignmentId),
  ).length;
  const progress = `${received} of ${plural(expected.length, "sheet")} received`;

  if (!round || round.status === "pending") {
    const drawn = draw.status !== "draft" && debateIds.size > 0;
    const canOpen = drawn && previousClosed;
    let summary: string;
    if (!drawn) summary = "Waiting for the draw.";
    else if (!previousClosed) summary = `Waiting for round ${number - 1} to close.`;
    else summary = `Not started. ${plural(expected.length, "sheet")} expected.`;
    return { key, title, state: canOpen ? "ready" : "not-started", summary, issues: [] };
  }
  if (twoVersions > 0) {
    return {
      key,
      title,
      state: "needs-attention",
      summary: `${progress}; ${twoVersions === 1 ? "one sheet has" : `${twoVersions} sheets have`} two versions`,
      issues: [],
    };
  }
  if (round.status === "closed") {
    return {
      key,
      title,
      state: "done",
      summary:
        missing > 0
          ? `Closed with ${plural(missing, "sheet")} still missing (${progress}).`
          : `Closed; ${progress}.`,
      issues: [],
    };
  }
  return {
    key,
    title,
    state: missing === 0 && expected.length > 0 ? "ready" : "in-progress",
    summary:
      missing === 0 && expected.length > 0 ? `${progress}; ready to close.` : `Open; ${progress}.`,
    issues: [],
  };
}

function resultsStep(graph: TournamentGraph, schedule: Schedule): ChecklistStep {
  const published = graph.divisions.filter((division) => division.finalizedAt !== null);
  const names = (list: typeof graph.divisions) =>
    list.map((division) => division.name).join(" and ");
  const openTwoVersions = graph.conflicts.filter((conflict) => conflict.status === "open").length;
  const allClosed =
    graph.rounds.length > 0 && graph.rounds.every((round) => round.status === "closed");
  let state: ChecklistState;
  let summary: string;
  if (published.length === graph.divisions.length && graph.divisions.length > 0) {
    state = "done";
    summary = `Results published for ${names(published)}.`;
  } else if (openTwoVersions > 0) {
    state = "needs-attention";
    summary = `${openTwoVersions === 1 ? "One sheet has" : `${openTwoVersions} sheets have`} two versions; settle them before publishing.`;
  } else if (published.length > 0) {
    state = "in-progress";
    summary = `Results published for ${names(published)}; ${names(graph.divisions.filter((d) => d.finalizedAt === null))} still provisional.`;
  } else if (allClosed) {
    state = "ready";
    summary = "Every round is closed; ready to publish results.";
  } else if (graph.sheets.length > 0) {
    state = "in-progress";
    summary = `Provisional; ${plural(graph.sheets.length, "sheet")} received so far.`;
  } else {
    state = "not-started";
    summary = schedule.debates.length > 0 ? "No sheets received yet." : "Waiting for the draw.";
  }
  return { key: "results", title: "Results", state, summary, issues: [] };
}

function applyOverride(step: ChecklistStep, overrides: ChecklistOverrideRow[]): ChecklistStep {
  const row = overrides.find((override) => override.stepKey === step.key);
  if (!row) return step;
  return {
    ...step,
    state: "done",
    override: {
      state: row.state,
      reason: row.reason,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Overrides

/**
 * Marks a step done or skipped whatever the data says, or clears such a
 * mark (`state: null`). Every call needs a reason; it is shown on the step.
 */
export async function setChecklistOverride(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  step: string,
  state: ChecklistOverrideState | null,
  reason: string,
): Promise<ChecklistOverride | null> {
  const schedule = toSchedule(await loadGraph(tx, tournamentId));
  if (!checklistKeys(schedule).includes(step)) throw errors.notFound("That checklist step");
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw errors.validation("Give a reason for this change. It is kept in the history.", {
      issues: [{ path: "reason", message: "A reason is required." }],
    });
  }
  const now = ctx.now();
  const [previous] = await tx
    .update(checklistOverrides)
    .set({ revokedAt: now, revokedBy: ctx.actor.name })
    .where(
      and(
        eq(checklistOverrides.tournamentId, tournamentId),
        eq(checklistOverrides.stepKey, step),
        isNull(checklistOverrides.revokedAt),
      ),
    )
    .returning();

  let created: ChecklistOverrideRow | undefined;
  if (state !== null) {
    [created] = await tx
      .insert(checklistOverrides)
      .values({
        tournamentId,
        stepKey: step,
        state,
        reason: trimmed,
        createdBy: ctx.actor.name,
        createdAt: now,
      })
      .returning();
  }
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.checklistOverridden,
    entityType: "checklist_step",
    entityId: step,
    reason: trimmed,
    before: previous ? { state: previous.state } : null,
    after: created ? { state: created.state } : { state: null },
  });
  return created
    ? {
        state: created.state,
        reason: created.reason,
        createdBy: created.createdBy,
        createdAt: created.createdAt,
      }
    : null;
}
