/**
 * Score overrides: the organiser's decisions applied after the outlier
 * policy. Each one names what it touches (a score, a debater or a team),
 * carries a reason, and is revoked by a timestamp rather than deleted, so
 * the results page can always explain why a score is kept or set aside.
 *
 * The scoring engine (`src/domain/scoring`) defines what each kind means;
 * this module checks that an override names the right things for its kind
 * and that they exist in the division before storing it. Waivers have their
 * own table and service (`./waivers`), so `waive_missing_sheet` is refused
 * here.
 */
import { and, asc, eq, isNull } from "drizzle-orm";

import {
  assignments,
  divisions,
  getDbDriver,
  scoreOverrides,
  speakers,
  teams,
  type DivisionRow,
  type ScoreOverrideRow,
  type Tx,
} from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { withTransaction, type Queryable, type ServiceContext } from "./context";
import { readCurrentSheet, refuseWhenPublished } from "./sheets";

/** The kinds this service stores. Waivers go through `waiveSheet`. */
export type ScoreOverrideKind = Exclude<ScoreOverrideRow["kind"], "waive_missing_sheet">;

export interface AddOverrideInput {
  tournamentId: string;
  divisionCode: string;
  kind: ScoreOverrideKind;
  /** The debater, for every kind except `rank_single_speaker_team`. */
  speakerId?: string;
  /** The team, for `rank_single_speaker_team`. */
  teamId?: string;
  /** Optional narrowing for `force_include` / `force_exclude`. */
  round?: number;
  /** The sheet, for `force_include` / `force_exclude`. */
  assignmentId?: string;
  reason: string;
}

type TargetField = "speakerId" | "teamId" | "round" | "assignmentId";

/** Which target fields each kind needs and which it may carry. */
const SHAPES: Record<ScoreOverrideKind, { required: TargetField[]; optional: TargetField[] }> = {
  force_include: { required: ["speakerId", "assignmentId"], optional: ["round"] },
  force_exclude: { required: ["speakerId", "assignmentId"], optional: ["round"] },
  keep_all_for_debater: { required: ["speakerId"], optional: [] },
  exclude_debater: { required: ["speakerId"], optional: [] },
  rank_single_speaker_team: { required: ["teamId"], optional: [] },
};

const KIND_WORDS: Record<ScoreOverrideKind, string> = {
  force_include: "keeping one score",
  force_exclude: "setting one score aside",
  keep_all_for_debater: "keeping every score for a debater",
  exclude_debater: "taking a debater out of the ranking",
  rank_single_speaker_team: "ranking a one-person team",
};

/**
 * Adds an override. Throws `validation` when the kind and its targets do
 * not fit together or name something outside the division, and
 * `division_finalized` (423) when the division is published (reopen first).
 */
export async function addOverride(
  ctx: ServiceContext,
  input: AddOverrideInput,
): Promise<ScoreOverrideRow> {
  checkShape(input);
  requireReason(input.reason);
  return withTransaction(ctx, async (tx) => {
    const division = await lockDivision(tx, input.tournamentId, input.divisionCode);
    refuseWhenPublished(division, "organiser");
    const target = await resolveTargets(tx, input);
    const normalised = {
      ...input,
      round: input.assignmentId ? (target.round as number) : input.round,
    };
    await refuseDuplicate(tx, normalised);

    const [row] = await tx
      .insert(scoreOverrides)
      .values({
        tournamentId: input.tournamentId,
        divisionCode: input.divisionCode,
        kind: input.kind,
        speakerId: input.speakerId ?? null,
        teamId: input.teamId ?? null,
        round: normalised.round ?? null,
        assignmentId: input.assignmentId ?? null,
        reason: input.reason.trim(),
        createdBy: ctx.actor.name,
        createdAt: ctx.now(),
      })
      .returning();
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.overrideAdded,
      entityType: "score_override",
      entityId: row.id,
      divisionCode: input.divisionCode,
      assignmentId: input.assignmentId ?? null,
      reason: input.reason,
      after: { kind: input.kind, what: KIND_WORDS[input.kind], ...target },
    });
    return row;
  });
}

export interface RevokeOverrideInput {
  tournamentId: string;
  overrideId: string;
  reason: string;
}

/** Takes an override back. The row stays, with who revoked it and why. */
export async function revokeOverride(
  ctx: ServiceContext,
  input: RevokeOverrideInput,
): Promise<ScoreOverrideRow> {
  requireReason(input.reason);
  return withTransaction(ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(scoreOverrides)
      .where(
        and(
          eq(scoreOverrides.tournamentId, input.tournamentId),
          eq(scoreOverrides.id, input.overrideId),
        ),
      )
      .limit(1);
    if (!existing) throw errors.notFound("That override");
    if (existing.revokedAt !== null) throw errors.validation("This override was already revoked.");
    const division = await lockDivision(tx, input.tournamentId, existing.divisionCode);
    refuseWhenPublished(division, "organiser");

    const [row] = await tx
      .update(scoreOverrides)
      .set({ revokedAt: ctx.now(), revokedBy: ctx.actor.name, revokedReason: input.reason.trim() })
      .where(eq(scoreOverrides.id, existing.id))
      .returning();
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: AUDIT_ACTIONS.overrideRevoked,
      entityType: "score_override",
      entityId: existing.id,
      divisionCode: existing.divisionCode,
      assignmentId: existing.assignmentId,
      reason: input.reason,
      before: { kind: existing.kind, reason: existing.reason, createdBy: existing.createdBy },
      after: { revoked: true },
    });
    return row;
  });
}

export interface ListOverridesOptions {
  includeRevoked?: boolean;
}

/** Overrides for the tournament or one division, oldest first; live ones unless asked. */
export async function listOverrides(
  db: Queryable,
  tournamentId: string,
  divisionCode?: string,
  options: ListOverridesOptions = {},
): Promise<ScoreOverrideRow[]> {
  const filters = [eq(scoreOverrides.tournamentId, tournamentId)];
  if (divisionCode !== undefined) filters.push(eq(scoreOverrides.divisionCode, divisionCode));
  if (!options.includeRevoked) filters.push(isNull(scoreOverrides.revokedAt));
  return db
    .select()
    .from(scoreOverrides)
    .where(and(...filters))
    .orderBy(asc(scoreOverrides.createdAt), asc(scoreOverrides.id));
}

// ---------------------------------------------------------------------------
// Checks

function checkShape(input: AddOverrideInput): void {
  const shape = SHAPES[input.kind as ScoreOverrideKind] as
    (typeof SHAPES)[ScoreOverrideKind] | undefined;
  if (!shape) {
    throw errors.validation(
      "That kind of override is not available here. To mark a sheet as won't arrive, waive it.",
      { issues: [{ path: "kind", message: "Unknown override kind." }] },
    );
  }
  const issues: { path: string; message: string }[] = [];
  for (const field of shape.required) {
    if (input[field] === undefined || input[field] === null) {
      issues.push({ path: field, message: `${KIND_WORDS[input.kind]} needs ${describe(field)}.` });
    }
  }
  const allowed = new Set<TargetField>([...shape.required, ...shape.optional]);
  for (const field of ["speakerId", "teamId", "round", "assignmentId"] as const) {
    if (!allowed.has(field) && input[field] !== undefined && input[field] !== null) {
      issues.push({
        path: field,
        message: `${KIND_WORDS[input.kind]} does not take ${describe(field)}.`,
      });
    }
  }
  if (input.round !== undefined && (!Number.isInteger(input.round) || input.round < 1)) {
    issues.push({ path: "round", message: "The round must be a whole number from 1." });
  }
  if (issues.length > 0) {
    throw errors.validation("This override does not name the right things for its kind.", {
      issues,
    });
  }
}

function describe(field: TargetField): string {
  switch (field) {
    case "speakerId":
      return "a debater";
    case "teamId":
      return "a team";
    case "round":
      return "a round";
    case "assignmentId":
      return "a sheet";
  }
}

/** The division row, locked on Postgres so publishing and overriding cannot cross. */
async function lockDivision(tx: Tx, tournamentId: string, code: string): Promise<DivisionRow> {
  const query = tx
    .select()
    .from(divisions)
    .where(and(eq(divisions.tournamentId, tournamentId), eq(divisions.code, code)))
    .limit(1)
    .$dynamic();
  const [row] = await (getDbDriver() === "pg" ? query.for("share") : query);
  if (!row) throw errors.notFound("That division");
  return row;
}

/**
 * Checks that the targets exist in this division and belong together, and
 * returns their names for the audit row.
 */
async function resolveTargets(tx: Tx, input: AddOverrideInput) {
  const names: Record<string, unknown> = {};
  if (input.speakerId !== undefined) {
    const [row] = await tx
      .select({ name: speakers.name, teamId: speakers.teamId, divisionCode: teams.divisionCode })
      .from(speakers)
      .innerJoin(teams, eq(teams.id, speakers.teamId))
      .where(and(eq(speakers.tournamentId, input.tournamentId), eq(speakers.id, input.speakerId)))
      .limit(1);
    if (!row || row.divisionCode !== input.divisionCode) {
      throw errors.validation("That debater is not in this division.", {
        issues: [{ path: "speakerId", message: "Unknown debater for this division." }],
      });
    }
    names.debaterName = row.name;
  }
  if (input.teamId !== undefined) {
    const [row] = await tx
      .select({ code: teams.code, name: teams.name, divisionCode: teams.divisionCode })
      .from(teams)
      .where(and(eq(teams.tournamentId, input.tournamentId), eq(teams.id, input.teamId)))
      .limit(1);
    if (!row || row.divisionCode !== input.divisionCode) {
      throw errors.validation("That team is not in this division.", {
        issues: [{ path: "teamId", message: "Unknown team for this division." }],
      });
    }
    names.teamCode = row.code;
    names.teamName = row.name;
  }
  if (input.assignmentId !== undefined) {
    const [row] = await tx
      .select()
      .from(assignments)
      .where(
        and(
          eq(assignments.tournamentId, input.tournamentId),
          eq(assignments.id, input.assignmentId),
        ),
      )
      .limit(1);
    const coversDebater =
      row !== undefined &&
      input.speakerId !== undefined &&
      row.identity.speakers.some((speaker) => speaker.id === input.speakerId);
    if (!row || row.identity.divisionCode !== input.divisionCode || !coversDebater) {
      throw errors.validation("That sheet does not score this debater.", {
        issues: [
          { path: "assignmentId", message: "The sheet must be one that scores the debater." },
        ],
      });
    }
    if (input.round !== undefined && row.identity.round !== input.round) {
      throw errors.validation(
        `That sheet is for round ${row.identity.round}, not round ${input.round}.`,
        {
          issues: [{ path: "round", message: "The round does not match the sheet." }],
        },
      );
    }
    if (row.retiredAt !== null) throw errors.validation("That sheet belongs to the old draw.");
    if ((await readCurrentSheet(tx, input.tournamentId, row.id)).row === null) {
      throw errors.validation("No sheet has been received for that judge yet.");
    }
    names.judgeName = row.display.judgeName;
    names.round = row.identity.round;
  }
  return names;
}

/** The same live override twice would only confuse the trace. */
async function refuseDuplicate(tx: Tx, input: AddOverrideInput): Promise<void> {
  const live = await listOverrides(tx, input.tournamentId, input.divisionCode);
  const same = live.find(
    (row) =>
      row.kind === input.kind &&
      row.speakerId === (input.speakerId ?? null) &&
      row.teamId === (input.teamId ?? null) &&
      row.round === (input.round ?? null) &&
      row.assignmentId === (input.assignmentId ?? null),
  );
  if (same) {
    throw errors.validation("An identical override is already in place.", { overrideId: same.id });
  }
}

function requireReason(reason: string): void {
  if (typeof reason === "string" && reason.trim().length > 0) return;
  throw errors.validation("Give a reason for this change. It is kept in the history.", {
    issues: [{ path: "reason", message: "A reason is required." }],
  });
}
