import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createUserSession, resolveUserSession } from "@/server/auth/session";
import { createInvite, verifyJoinToken } from "@/server/auth/tokens";
import { getDb, judges, organisations, tournaments } from "@/server/db";
import { getPublicExample, startVisitorDemo } from "@/server/demo-entry";
import { publicTournament } from "@/server/public-tournament";
import { signUpFirstOwner } from "@/server/services/users";
import { withTransaction } from "@/server/services/context";
import { seedTournament, testContext } from "./helpers";

describe("public demo isolation", () => {
  it("issues a valid sample judge link and repairs a reused demo's legacy credential", async () => {
    const db = await getDb(),
      ctx = testContext(db);
    const demo = await startVisitorDemo(ctx, undefined, true);
    const token = new URL(demo.location).searchParams.get("t")!;
    const judge = await verifyJoinToken(db, token);
    expect(judge).not.toBeNull();
    await db
      .update(judges)
      .set({ joinTokenHash: "legacy-demo-placeholder" })
      .where(eq(judges.id, judge!.id));
    const reused = await startVisitorDemo(ctx, demo.token, true);
    expect(reused.token).toBeUndefined();
    expect(
      await verifyJoinToken(db, new URL(reused.location).searchParams.get("t")!),
    ).toMatchObject({ id: judge!.id });
  });

  it("creates an expiring visitor tenancy, reuses it and never grants invites", async () => {
    const db = await getDb(),
      ctx = testContext(db);
    const result = await startVisitorDemo(ctx, undefined);
    expect(result.token).toBeTruthy();
    const session = await resolveUserSession(db, result.token!);
    expect(session?.memberships).toHaveLength(1);
    const orgId = session!.memberships[0].organisationId;
    const [org] = await db.select().from(organisations).where(eq(organisations.id, orgId));
    const [tournament] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.organisationId, orgId));
    expect(org.isDemo).toBe(true);
    expect(tournament.kind).toBe("demo");
    expect(tournament.demoExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(tournament.demoExpiresAt!.getTime()).toBeLessThan(Date.now() + 25 * 3600_000);
    expect(await startVisitorDemo(ctx, result.token)).toEqual({
      location: result.location,
      token: undefined,
    });
    await expect(
      withTransaction(ctx, (tx) =>
        createInvite(tx, ctx, {
          organisationId: orgId,
          email: `invite-${randomUUID()}@example.test`,
          role: "owner",
          invitedBy: session!.user.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("allows first real owner setup after anonymous demos", async () => {
    if (process.env.DATABASE_URL_TEST) return; // A shared Postgres already has other fixtures.
    const db = await getDb(),
      ctx = testContext(db);
    const owner = await withTransaction(ctx, (tx) =>
      signUpFirstOwner(tx, ctx, {
        orgName: "Fictional school society",
        email: `owner-${randomUUID()}@example.test`,
        name: "Taylor Owner",
        password: "fictional owner password for testing",
      }),
    );
    expect(owner.organisation.isDemo).toBe(false);
  });

  it("keeps an authenticated real organisation untouched when starting a demo", async () => {
    const db = await getDb(),
      ctx = testContext(db),
      seed = await seedTournament(db);
    const issued = await createUserSession(db, ctx, seed.userId);
    const result = await startVisitorDemo(ctx, issued.token);
    expect(result.token).toBeUndefined();
    const session = await resolveUserSession(db, issued.token);
    expect(session?.user.id).toBe(seed.userId);
    expect(session?.memberships).toHaveLength(2);
    const [original] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, seed.tournamentId));
    expect(original.kind).toBe("sandbox");
    const [demo] = await db
      .select()
      .from(tournaments)
      .where(eq(tournaments.slug, result.location.split("/").pop()!));
    expect(demo.kind).toBe("demo");
    expect(demo.organisationId).not.toBe(seed.organisationId);
    expect(demo.demoExpiresAt).toBeInstanceOf(Date);
    expect((await startVisitorDemo(ctx, issued.token)).location).toBe(result.location);
  });

  it("reuses a published read-only example without issuing an owner session", async () => {
    const db = await getDb(),
      ctx = testContext(db);
    const path = await getPublicExample(ctx);
    expect(await getPublicExample(ctx)).toBe(path);
    const data = await publicTournament(db, decodeURIComponent(path.slice(3)));
    expect(data.results).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain("joinToken");
  });
});
