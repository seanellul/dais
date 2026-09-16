import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@/domain/schedule/canonical-json";
import { auditLog, divisions } from "@/server/db";
import { errors } from "@/server/errors";
import { recordAudit } from "./audit";
import { withTransaction, type Queryable, type ServiceContext } from "./context";
import { loadGraph } from "./graph";
import { buildResultsView, type DivisionResultsView } from "./results";

const confirmationSchema = z.object({
  teamIds: z.array(z.string()).length(2),
  fingerprint: z.string(),
});

/** Changes to scores, waivers, policy or the roster invalidate a past decision. */
export function finalistFingerprint(view: DivisionResultsView): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        policy: view.policy,
        teams: view.teams.map(({ id, total, rank }) => ({ id, total, rank })),
        scores: view.debaters.map(({ id, rounds }) => ({ id, rounds })),
        completeness: view.completeness,
        openConflicts: view.openConflicts,
      }),
    )
    .digest("hex");
}

export interface FinalistConfirmation {
  teamIds: string[];
  reason: string;
  by: string;
  at: string;
}

/** Only the latest decision may apply; an older matching state is never resurrected. */
export async function getFinalistConfirmation(
  db: Queryable,
  view: DivisionResultsView,
): Promise<FinalistConfirmation | null> {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tournamentId, view.tournamentId),
        eq(auditLog.divisionCode, view.divisionCode),
        eq(auditLog.action, "finalists.confirmed"),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(1);
  const parsed = confirmationSchema.safeParse(row?.after);
  if (!row || !parsed.success || parsed.data.fingerprint !== finalistFingerprint(view)) return null;
  return {
    teamIds: parsed.data.teamIds,
    reason: row.reason ?? "",
    by: row.actorName ?? "Organiser",
    at: row.at.toISOString(),
  };
}

export async function confirmFinalists(
  ctx: ServiceContext,
  input: {
    tournamentId: string;
    divisionCode: string;
    teamIds: string[];
    reason: string;
  },
): Promise<FinalistConfirmation> {
  if (!input.reason.trim())
    throw errors.validation(
      "Give a reason for choosing these finalists. It is kept in the history.",
    );
  return withTransaction(ctx, async (tx) => {
    const [division] = await tx
      .select()
      .from(divisions)
      .where(
        and(eq(divisions.tournamentId, input.tournamentId), eq(divisions.code, input.divisionCode)),
      )
      .for("update");
    if (!division) throw errors.notFound("That division");
    const view = buildResultsView(await loadGraph(tx, input.tournamentId), input.divisionCode);
    if (!view.completeness.finalizable || view.openConflicts) {
      throw errors.validation(
        "Resolve the missing sheets and scoring decisions before confirming finalists.",
      );
    }
    const cutoff = view.finalists.tieAtCut;
    const eligible = new Set(
      [...view.finalists.teams, ...(cutoff?.teams ?? [])].map((team) => team.id),
    );
    const required = view.teams.filter(
      (team) => team.rank !== null && (cutoff ? team.rank < cutoff.rank : eligible.has(team.id)),
    );
    if (
      input.teamIds.length !== 2 ||
      new Set(input.teamIds).size !== 2 ||
      input.teamIds.some((id) => !eligible.has(id)) ||
      required.some((team) => !input.teamIds.includes(team.id))
    ) {
      throw errors.validation(
        "Choose the two highest-ranked teams, resolving only the tie at the final place.",
      );
    }
    await recordAudit(tx, ctx, {
      tournamentId: input.tournamentId,
      action: "finalists.confirmed",
      entityType: "division",
      entityId: division.id,
      divisionCode: division.code,
      reason: input.reason,
      after: { teamIds: input.teamIds, fingerprint: finalistFingerprint(view) },
    });
    return {
      teamIds: input.teamIds,
      reason: input.reason.trim(),
      by: ctx.actor.name,
      at: ctx.now().toISOString(),
    };
  });
}
