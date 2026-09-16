/**
 * Tournament settings and the outlier policy.
 *
 * Settings are one JSON document (`parseSettings` is the contract) mirrored
 * by the `divisions` and `rounds` tables, which this module keeps in step.
 * Two rules protect the day:
 * - Once any sheet has been received, the rubric and the rounds are fixed.
 *   Sheets were scored against them; changing them would change what the
 *   numbers mean.
 * - The outlier policy cannot change while a division's results are
 *   published. The division holds a snapshot of the policy it was published
 *   under, and a later edit must never look like it changed that result.
 */
import { and, count, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { policyEquals, type LoppingPolicy } from "@/domain/scoring";
import { canonicalJson } from "@/domain/schedule";
import { parseSettings } from "@/domain/settings";
import type { TournamentSettings } from "@/domain/types";
import { debates, divisions, rounds, sheets, teams, tournaments, type Tx } from "@/server/db";
import { errors } from "@/server/errors";

import { AUDIT_ACTIONS, diffOf, recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { refreshAssignments } from "./draw";
import { settingsOf } from "./graph";
import { joinCode } from "./ids";
import { lockTournament, retryOnUniqueViolation } from "./tournaments";

/** The outlier policy's shape, for a patch arriving from a form. */
export const loppingPolicySchema = z.object({
  sdMultiplier: z.number().positive({ error: "The kept range must be wider than zero spreads." }),
  bounds: z.enum(["strict", "inclusive"]),
  scope: z.enum(["pooled", "perRound"]),
  passes: z.enum(["one", "iterative"]),
  sd: z.enum(["sample", "population"]),
  whenUndefined: z.enum(["unresolved", "keepAll"]),
  zeroSpread: z.enum(["unresolved", "keepAll"]),
  excelCriteriaRounding: z.boolean(),
});

export interface UpdateSettingsOptions {
  expectedRevision?: number;
}

/**
 * Applies a partial change to the settings, validates the result, keeps the
 * divisions and rounds tables in step, and records the diff.
 */
export async function updateSettings(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  patch: Partial<TournamentSettings>,
  options: UpdateSettingsOptions = {},
): Promise<TournamentSettings> {
  const tournament = await lockTournament(tx, tournamentId);
  if (options.expectedRevision !== undefined && options.expectedRevision !== tournament.revision) {
    throw errors.setupStale({
      currentRevision: tournament.revision,
      baseRevision: options.expectedRevision,
    });
  }
  const before = settingsOf(tournament);
  const parsed = parseSettings({ ...before, ...patch });
  if (!parsed.ok) {
    throw errors.validation("Some of the settings are not valid.", { issues: parsed.errors });
  }
  const after = parsed.data;
  const diff = diffOf(before, after);
  if (diff.length === 0) return before;

  const rubricChanged = canonicalJson(before.rubric) !== canonicalJson(after.rubric);
  const roundsChanged = canonicalJson(before.rounds) !== canonicalJson(after.rounds);
  if ((rubricChanged || roundsChanged) && (await sheetsExist(tx, tournamentId))) {
    throw errors.validation(
      "Sheets have already been received, so the rubric and the rounds can't be changed now.",
    );
  }

  await syncDivisions(tx, tournamentId, before, after, ctx.now());
  await syncRounds(tx, tournamentId, before, after, ctx.now());
  await tx
    .update(tournaments)
    .set({ settings: after, updatedAt: ctx.now() })
    .where(eq(tournaments.id, tournamentId));
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.settingsUpdated,
    entityType: "tournament",
    entityId: tournamentId,
    diff,
  });
  if (roundsChanged && (await debatesExist(tx, tournamentId))) {
    // Format and sides are shown on every sheet; refresh them in place.
    await refreshAssignments(tx, ctx, tournamentId, { expectedRevision: options.expectedRevision });
  }
  return after;
}

async function sheetsExist(tx: Tx, tournamentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ total: count() })
    .from(sheets)
    .where(eq(sheets.tournamentId, tournamentId));
  return (row?.total ?? 0) > 0;
}

async function debatesExist(tx: Tx, tournamentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ total: count() })
    .from(debates)
    .where(eq(debates.tournamentId, tournamentId));
  return (row?.total ?? 0) > 0;
}

/** Adds, renames or removes `divisions` rows to match the settings. A division with teams stays. */
async function syncDivisions(
  tx: Tx,
  tournamentId: string,
  before: TournamentSettings,
  after: TournamentSettings,
  now: Date,
): Promise<void> {
  const wanted = new Map(
    after.divisions.map((division, index) => [division.code, { ...division, index }]),
  );
  for (const division of before.divisions) {
    if (wanted.has(division.code)) continue;
    const [teamCount] = await tx
      .select({ total: count() })
      .from(teams)
      .where(and(eq(teams.tournamentId, tournamentId), eq(teams.divisionCode, division.code)));
    if ((teamCount?.total ?? 0) > 0) {
      throw errors.validation(
        `${division.name} still has teams. Move or delete them before removing the division.`,
      );
    }
    await tx
      .delete(divisions)
      .where(and(eq(divisions.tournamentId, tournamentId), eq(divisions.code, division.code)));
  }
  const existing = new Set(before.divisions.map((division) => division.code));
  for (const [code, division] of wanted) {
    if (existing.has(code)) {
      await tx
        .update(divisions)
        .set({ name: division.name, sortOrder: division.index + 1 })
        .where(and(eq(divisions.tournamentId, tournamentId), eq(divisions.code, code)));
    } else {
      await tx.insert(divisions).values({
        tournamentId,
        code,
        name: division.name,
        sortOrder: division.index + 1,
        createdAt: now,
      });
    }
  }
}

/** Adds, updates or removes `rounds` rows to match the settings. A round with debates stays. */
async function syncRounds(
  tx: Tx,
  tournamentId: string,
  before: TournamentSettings,
  after: TournamentSettings,
  now: Date,
): Promise<void> {
  const wanted = new Map(after.rounds.map((round) => [round.number, round]));
  for (const round of before.rounds) {
    if (wanted.has(round.number)) continue;
    const [debateCount] = await tx
      .select({ total: count() })
      .from(debates)
      .where(and(eq(debates.tournamentId, tournamentId), eq(debates.round, round.number)));
    if ((debateCount?.total ?? 0) > 0) {
      throw errors.validation(
        `Round ${round.number} is in the draw. Take its debates out of the draw before removing it.`,
      );
    }
    await tx
      .delete(rounds)
      .where(and(eq(rounds.tournamentId, tournamentId), eq(rounds.number, round.number)));
  }
  const existing = new Set(before.rounds.map((round) => round.number));
  for (const [number, round] of wanted) {
    if (existing.has(number)) {
      await tx
        .update(rounds)
        .set({ format: round.format, sidesDecided: round.sidesDecided })
        .where(and(eq(rounds.tournamentId, tournamentId), eq(rounds.number, number)));
    } else {
      await tx.insert(rounds).values({
        tournamentId,
        number,
        format: round.format,
        sidesDecided: round.sidesDecided,
        createdAt: now,
      });
    }
  }
}

/**
 * Changes how scores are set aside. Refused while any division's results
 * are published: reopen them first, so the change is a visible decision.
 */
export async function updateScoringPolicy(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  input: LoppingPolicy,
  options: { reason?: string } = {},
): Promise<LoppingPolicy> {
  const parsed = loppingPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw errors.validation("The outlier policy is not valid.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  }
  const policy = parsed.data;
  const tournament = await lockTournament(tx, tournamentId);
  const before = tournament.scoringPolicy as unknown as LoppingPolicy;
  if (policyEquals(before, policy)) return before;

  const [published] = await tx
    .select({ code: divisions.code, finalizedAt: divisions.finalizedAt })
    .from(divisions)
    .where(and(eq(divisions.tournamentId, tournamentId), isNotNull(divisions.finalizedAt)))
    .limit(1);
  if (published) {
    throw errors.divisionFinalized({
      divisionCode: published.code,
      finalizedAt: published.finalizedAt?.toISOString(),
    });
  }
  await tx
    .update(tournaments)
    .set({ scoringPolicy: { ...policy }, updatedAt: ctx.now() })
    .where(eq(tournaments.id, tournamentId));
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.settingsUpdated,
    entityType: "tournament",
    entityId: tournamentId,
    diff: diffOf({ scoringPolicy: before }, { scoringPolicy: policy }),
    reason: options.reason,
  });
  return policy;
}

/** Issues a new join code, for a code that leaked or was printed wrongly. Judges already signed in are unaffected. */
export async function regenerateJoinCode(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
): Promise<string> {
  const tournament = await lockTournament(tx, tournamentId);
  const code = await retryOnUniqueViolation(tx, "tournaments_join_code_unique", 5, async (sp) => {
    const fresh = joinCode();
    await sp
      .update(tournaments)
      .set({ joinCode: fresh, updatedAt: ctx.now() })
      .where(eq(tournaments.id, tournamentId));
    return fresh;
  });
  await recordAudit(tx, ctx, {
    tournamentId,
    action: AUDIT_ACTIONS.settingsUpdated,
    entityType: "tournament",
    entityId: tournamentId,
    diff: diffOf({ joinCode: tournament.joinCode }, { joinCode: code }),
  });
  return code;
}
