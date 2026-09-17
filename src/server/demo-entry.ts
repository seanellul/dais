import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { publicPathFor } from "@/domain/public-page";
import { createUserSession, resolveUserSession } from "@/server/auth/session";
import { ensureMembership, issueJoinToken, joinLinkFor, joinTokenFor } from "@/server/auth/tokens";
import { judges, organisations, tournaments } from "@/server/db";
import { getEnv } from "@/server/env";
import { errors } from "@/server/errors";
import { createDemoTournament } from "@/server/services/demo";
import { cleanupExpired, lazySweep } from "@/server/services/cleanup";
import { withTransaction, type ServiceContext } from "@/server/services/context";
import { finalizeDivision } from "@/server/services/finalize";
import { loadGraph } from "@/server/services/graph";

export const DEMO_CAP = 100;
const EXAMPLE_SLUG = "dais-public-example";

export async function startVisitorDemo(
  ctx: ServiceContext,
  sessionToken: string | undefined,
  judgeMode = false,
) {
  if (!getEnv().DEMO_ENABLED) throw errors.notFound("The demo");
  await lazySweep(ctx);
  const current = sessionToken ? await resolveUserSession(ctx.db, sessionToken, ctx.now) : null;
  const organisationIds = current?.memberships.map((member) => member.organisationId) ?? [];
  const [organisation] = organisationIds.length
    ? await ctx.db
        .select()
        .from(organisations)
        .where(and(inArray(organisations.id, organisationIds), eq(organisations.isDemo, true)))
    : [];
  let existing = organisation?.isDemo
    ? (
        await ctx.db
          .select()
          .from(tournaments)
          .where(
            and(
              eq(tournaments.organisationId, organisation.id),
              gt(tournaments.demoExpiresAt, ctx.now()),
            ),
          )
          .limit(1)
      )[0]
    : undefined;
  let issued: string | undefined;
  if (!existing) {
    const created = await withTransaction(ctx, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dais:public-demo-cap'))`);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(tournaments)
        .where(and(eq(tournaments.kind, "demo"), gt(tournaments.demoExpiresAt, ctx.now())));
      if (count >= DEMO_CAP) throw errors.rateLimited(600);
      const demo = await createDemoTournament(
        { ...ctx, db: tx },
        {
          kind: "demo",
          stage: "round1-half",
          seed: `visitor-${crypto.randomUUID()}`,
        },
      );
      if (current) {
        // Keep the real session and real organisation untouched. Only this
        // visitor gains membership of their isolated, expiring demo tenancy.
        await ensureMembership(tx, demo.organisationId, current.user.id, "owner", ctx.now());
      } else if (demo.userId) {
        const session = await createUserSession(tx, ctx, demo.userId);
        issued = session.token;
      }
      return demo;
    });
    [existing] = await ctx.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, created.tournamentId));
  }
  if (!existing) throw errors.notFound("That demo");
  if (judgeMode) {
    const graph = await loadGraph(ctx.db, existing.id);
    const assignment = graph.assignments.find(
      (assignment) =>
        assignment.live &&
        assignment.identity.round === 1 &&
        !graph.sheets.some((sheet) => sheet.assignmentId === assignment.id),
    );
    const judge = graph.judges.find((judge) => judge.id === assignment?.judgeId) ?? graph.judges[0];
    if (!judge) throw errors.notFound("A sample judge");
    // Older demos stored a placeholder hash. Issue the card before returning
    // its link so those existing visitor sessions can start judging too.
    const joinToken = await withTransaction(ctx, (tx) => issueJoinToken(tx, ctx, judge.id));
    return { location: joinLinkFor(joinToken), token: issued };
  }
  return { location: `/t/${existing.slug}`, token: issued };
}

/** One uneditable completed example. No session for its synthetic owner is issued. */
export async function getPublicExample(ctx: ServiceContext) {
  if (!getEnv().DEMO_ENABLED) throw errors.notFound("The demo");
  await cleanupExpired(ctx);
  return withTransaction(ctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dais:public-demo-cap'))`);
    const [existing] = await tx
      .select({ tournament: tournaments })
      .from(tournaments)
      .innerJoin(organisations, eq(organisations.id, tournaments.organisationId))
      .where(and(eq(organisations.slug, EXAMPLE_SLUG), eq(organisations.isDemo, true)))
      .limit(1);
    if (existing) return publicPathFor(existing.tournament);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tournaments)
      .where(and(eq(tournaments.kind, "demo"), gt(tournaments.demoExpiresAt, ctx.now())));
    if (count >= DEMO_CAP) throw errors.rateLimited(600);
    const demo = await createDemoTournament(
      { ...ctx, db: tx },
      {
        kind: "demo",
        name: "Dais — sample schools tournament",
        stage: "complete",
        seed: "public-example-v1",
      },
    );
    await tx
      .update(organisations)
      .set({ slug: EXAMPLE_SLUG })
      .where(eq(organisations.id, demo.organisationId));
    const graph = await loadGraph(tx, demo.tournamentId);
    await tx
      .update(tournaments)
      .set({
        settings: {
          ...graph.tournament.settings,
          publicPage: { enabled: true, showProvisional: false },
        },
      })
      .where(eq(tournaments.id, demo.tournamentId));
    for (const division of graph.divisions)
      await finalizeDivision(
        { ...ctx, db: tx },
        { tournamentId: demo.tournamentId, divisionCode: division.code, acknowledgePolicy: true },
      );
    return publicPathFor(graph.tournament);
  });
}

export async function demoJudgeCard(ctx: ServiceContext, tournamentId: string) {
  const [judge] = await ctx.db
    .select()
    .from(judges)
    .where(eq(judges.tournamentId, tournamentId))
    .limit(1);
  return judge ? { name: judge.name, url: joinLinkFor(joinTokenFor(judge)) } : null;
}
