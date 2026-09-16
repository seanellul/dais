import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { simulateSheet } from "@/domain/sample";
import type { JudgeBootstrap } from "@/judge/api-types";
import { GET as me } from "@/app/api/judge/me/route";
import { GET as list } from "@/app/api/judge/assignments/route";
import { POST as login } from "@/app/api/judge/login/route";
import { POST as join } from "@/app/api/judge/join/route";
import { POST as sheet } from "@/app/api/judge/sheets/route";
import { POST as sync } from "@/app/api/judge/sync/route";
import { POST as heartbeat } from "@/app/api/judge/heartbeat/route";
import { POST as logout } from "@/app/api/judge/logout/route";
import { GET as live } from "@/app/api/t/[id]/live/route";
import { createUserSession } from "@/server/auth/session";
import { issueJoinToken } from "@/server/auth/tokens";
import * as joinTokens from "@/server/auth/tokens";
import * as judgeSessions from "@/server/auth/judge-session";
import { revokeJudgeSessions } from "@/server/auth/judge-session";
import {
  assignments,
  divisions,
  getDb,
  judgeDevices,
  judges,
  rateLimits,
  sheetVersions,
} from "@/server/db";
import { hashToken, loadGraph, withTransaction } from "@/server/services";
import { previewDraw, saveDraw } from "@/server/services/draw";
import { seedTournament, seedSample, testContext } from "./helpers";

function request(path: string, body?: unknown, cookie = "", extra: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      origin: "http://localhost:3000",
      "x-request-id": "api-test",
      "content-type": "application/json",
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function fixture() {
  const db = await getDb();
  const tournament = await seedTournament(db);
  await seedSample(db, tournament.tournamentId, {
    open: 4,
    novice: 4,
    rooms: 4,
    judgesPerRoom: 3,
    seed: "api",
  });
  const c = testContext(db);
  const preview = await previewDraw(db, c, tournament.tournamentId, {
    divisionCodes: tournament.divisionCodes,
    seed: "API",
  });
  await withTransaction(c, (tx) =>
    saveDraw(tx, c, tournament.tournamentId, { baseRevision: 0, debates: preview.debates }),
  );
  const graph = await loadGraph(db, tournament.tournamentId);
  const own = graph.assignments[0];
  const judge = graph.judges.find((row) => row.id === own.judgeId)!;
  const foreign = graph.assignments.find((row) => row.judgeId !== judge.id)!;
  const payload = simulateSheet({
    seed: "api",
    assignmentDisplay: own.display,
    rubric: tournament.settings.rubric,
    judgeId: judge.id,
    rogueChance: 0,
  });
  // Avoid coupling per-IP rate counters between independent tests.
  await db.delete(rateLimits);
  const signedIn = await login(
    request("/api/judge/login", {
      tournamentCode: tournament.joinCode.toLowerCase(),
      judgeCode: judge.code.toLowerCase(),
    }),
  );
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
  return { db, c, tournament, own, foreign, judge, payload, cookie, signedIn };
}

describe("actual judge route handlers", () => {
  it("signs in, projects only own sheets, renews secure session attributes and leaks no credentials", async () => {
    const f = await fixture();
    expect(f.signedIn.headers.get("set-cookie")).toContain("HttpOnly");
    expect(f.signedIn.headers.get("set-cookie")).toContain("SameSite=lax");
    const response = await me(request("/api/judge/me", undefined, f.cookie));
    const body: { data: JudgeBootstrap } = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("x-dais")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data.assignments.length).toBeGreaterThan(0);
    expect(body.data.assignments.every((row) => row.identity.judgeId === f.judge.id)).toBe(true);
    expect(body.data.assignments.find((row) => row.id === f.own.id)?.current).toBeNull();
    const text = JSON.stringify(body);
    for (const secret of ["tokenHash", "joinToken", "sessionEpoch", "identityHash", "judgeCode"])
      expect(text).not.toContain(secret);
    expect(
      await (await list(request("/api/judge/assignments", undefined, f.cookie))).json(),
    ).toEqual(body);
  });
  it("rejects a foreign assignment before revealing retired metadata, and ignores supplied actor IDs", async () => {
    const f = await fixture();
    await f.db
      .update(assignments)
      .set({ retiredAt: new Date() })
      .where(eq(assignments.id, f.foreign.id));
    const response = await sheet(
      request(
        "/api/judge/sheets",
        {
          assignmentId: f.foreign.id,
          requestId: "foreign",
          baseVersion: 0,
          payload: f.payload,
          judgeId: f.foreign.judgeId,
          tournamentId: f.tournament.tournamentId,
        },
        f.cookie,
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden", requestId: "api-test" });
    expect(
      await f.db.select().from(sheetVersions).where(eq(sheetVersions.assignmentId, f.foreign.id)),
    ).toHaveLength(0);
  });
  it("stores a sheet, replays its durable receipt and projects current content", async () => {
    const f = await fixture();
    const body = { assignmentId: f.own.id, requestId: "first", baseVersion: 0, payload: f.payload };
    const first = await sheet(request("/api/judge/sheets", body, f.cookie));
    expect(first.status).toBe(200);
    const receipt = await first.json();
    expect(await (await sheet(request("/api/judge/sheets", body, f.cookie))).json()).toEqual(
      receipt,
    );
    expect(
      await f.db.select().from(sheetVersions).where(eq(sheetVersions.assignmentId, f.own.id)),
    ).toHaveLength(1);
    const projected = await (await me(request("/api/judge/me", undefined, f.cookie))).json();
    expect(
      projected.data.assignments.find((row: { id: string }) => row.id === f.own.id).current,
    ).toMatchObject({ version: 1, payload: f.payload });
  });
  it("preserves successful sync receipts beside foreign and malformed failures and limits batch size", async () => {
    const f = await fixture();
    const batch = [
      { assignmentId: f.own.id, requestId: "batch-good", baseVersion: 0, payload: f.payload },
      { assignmentId: f.foreign.id, requestId: "batch-bad", baseVersion: 0, payload: f.payload },
      { requestId: "bad-shape" },
    ];
    const response = await sync(request("/api/judge/sync", batch, f.cookie));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((row: { status: number }) => row.status)).toEqual([200, 403, 400]);
    expect(body.data[0].data.status).toBe("received");
    expect(body.data[1].error.code).toBe("forbidden");
    const replay = await (await sync(request("/api/judge/sync", batch, f.cookie))).json();
    expect(replay.data[0]).toEqual(body.data[0]);
    expect(
      (
        await sync(
          request(
            "/api/judge/sync",
            Array.from({ length: 21 }, () => batch[0]),
            f.cookie,
          ),
        )
      ).status,
    ).toBe(400);
  });
  it("returns conflict data and marks the assignment as needing organiser attention", async () => {
    const f = await fixture();
    const body = {
      assignmentId: f.own.id,
      requestId: "initial",
      baseVersion: 0,
      payload: f.payload,
    };
    await sheet(request("/api/judge/sheets", body, f.cookie));
    const changed = structuredClone(f.payload);
    const speaker = f.own.identity.speakers[0].id;
    changed.scores[speaker].overall = changed.scores[speaker].overall === 80 ? 79 : 80;
    const response = await sheet(
      request(
        "/api/judge/sheets",
        { ...body, requestId: "conflicting", payload: changed },
        f.cookie,
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "version_conflict",
      details: { receipt: { status: "conflict" } },
    });
    const projected = await (await me(request("/api/judge/me", undefined, f.cookie))).json();
    expect(
      projected.data.assignments.find((row: { id: string }) => row.id === f.own.id).openConflict,
    ).toBe(true);
  });
  it("projects retired successor metadata and refuses stale/finalized submissions", async () => {
    const f = await fixture();
    const body = {
      assignmentId: f.own.id,
      requestId: "retired",
      baseVersion: 0,
      payload: f.payload,
    };
    const replacement = {
      ...f.own,
      id: "replacement-api",
      successorId: null,
      retiredAt: null,
      live: undefined,
    };
    await f.db
      .update(assignments)
      .set({ retiredAt: new Date() })
      .where(eq(assignments.id, f.own.id));
    await f.db.insert(assignments).values(replacement);
    await f.db
      .update(assignments)
      .set({ retiredAt: new Date(), successorId: replacement.id })
      .where(eq(assignments.id, f.own.id));
    const retired = await sheet(request("/api/judge/sheets", body, f.cookie));
    expect(retired.status).toBe(409);
    expect(await retired.json()).toMatchObject({
      code: "assignment_retired",
      details: { successorId: replacement.id },
    });
    const projected = await (await me(request("/api/judge/me", undefined, f.cookie))).json();
    expect(
      projected.data.assignments.find((row: { id: string }) => row.id === f.own.id),
    ).toMatchObject({ successorId: replacement.id });
    await f.db
      .update(divisions)
      .set({ finalizedAt: new Date() })
      .where(
        and(
          eq(divisions.tournamentId, f.tournament.tournamentId),
          eq(divisions.code, f.own.identity.divisionCode),
        ),
      );
    expect(
      (
        await sheet(
          request(
            "/api/judge/sheets",
            { ...body, assignmentId: replacement.id, requestId: "published" },
            f.cookie,
          ),
        )
      ).status,
    ).toBe(423);
  });
  it("persists heartbeats only for owned sheets and server-side logout invalidates a copied cookie", async () => {
    const f = await fixture();
    expect(
      (
        await heartbeat(
          request(
            "/api/judge/heartbeat",
            { deviceId: "test-device", statuses: [{ assignmentId: f.own.id, state: "queued" }] },
            f.cookie,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await f.db.select().from(judgeDevices).where(eq(judgeDevices.judgeId, f.judge.id)),
    ).toMatchObject([{ queuedCount: 1 }]);
    expect(
      (
        await heartbeat(
          request(
            "/api/judge/heartbeat",
            {
              deviceId: "test-device",
              statuses: [{ assignmentId: f.foreign.id, state: "queued" }],
            },
            f.cookie,
          ),
        )
      ).status,
    ).toBe(403);
    expect((await logout(request("/api/judge/logout", {}, f.cookie))).status).toBe(200);
    expect((await me(request("/api/judge/me", undefined, f.cookie))).status).toBe(401);
  });
  it("rejects revoked sessions and accepts live QR tokens", async () => {
    const f = await fixture();
    await withTransaction(f.c, (tx) => revokeJudgeSessions(tx, f.c, f.judge.id, "Test revocation"));
    expect((await me(request("/api/judge/me", undefined, f.cookie))).status).toBe(401);
    const issued = await withTransaction(f.c, (tx) => issueJoinToken(tx, f.c, f.judge.id));
    expect((await join(request("/api/judge/join", { token: issued }))).status).toBe(200);
  });
  it("allows 30 distinct judges to sign in and join from one venue IP", async () => {
    const db = await getDb();
    const tournament = await seedTournament(db);
    const c = testContext(db);
    await db.delete(rateLimits);
    const roster = await db
      .insert(judges)
      .values(
        Array.from({ length: 30 }, (_, index) => ({
          tournamentId: tournament.tournamentId,
          name: `Venue Judge ${index + 1}`,
          joinTokenHash: hashToken(crypto.randomUUID()),
          code: `VENUE${String(index + 1).padStart(2, "0")}`,
        })),
      )
      .returning();
    for (const judge of roster) {
      const signedIn = await login(
        request("/api/judge/login", { tournamentCode: tournament.joinCode, judgeCode: judge.code }),
      );
      expect(signedIn.status).toBe(200);
      const token = await withTransaction(c, (tx) => issueJoinToken(tx, c, judge.id));
      expect((await join(request("/api/judge/join", { token }))).status).toBe(200);
    }
    // The default unproxied request has the same unknown-IP bucket for all 60 attempts.
    const counters = await db.select().from(rateLimits);
    expect(counters.find((row) => row.key.startsWith("judge-signin:ip:"))?.tokens).toBe(60);
  });
  it("serializes QR proof and session creation against revocation of the verified epoch", async () => {
    const f = await fixture();
    const token = await withTransaction(f.c, (tx) => issueJoinToken(tx, f.c, f.judge.id));
    const verify = joinTokens.verifyJoinToken;
    const create = judgeSessions.createJudgeSession;
    let revocation: Promise<unknown> | undefined;
    let proofHandle: Parameters<typeof verify>[0] | undefined;
    let sessionHandle: Parameters<typeof create>[0] | undefined;
    const verificationSpy = vi
      .spyOn(joinTokens, "verifyJoinToken")
      .mockImplementation(async (db, proof) => {
        const judge = await verify(db, proof);
        proofHandle = db;
        if (judge) {
          revocation = withTransaction(f.c, (tx) =>
            revokeJudgeSessions(tx, f.c, judge.id, "Race regression"),
          );
          // An unprotected verifier lets revocation finish before session creation,
          // reproducing the original bug. With a transaction, release this barrier
          // so its SHARE lock can commit before the waiting revoke obtains UPDATE.
          if (db === f.db) await revocation;
        }
        return judge;
      });
    const sessionSpy = vi
      .spyOn(judgeSessions, "createJudgeSession")
      .mockImplementation(async (...args) => {
        sessionHandle = args[0];
        return create(...args);
      });
    try {
      const response = await join(request("/api/judge/join", { token }));
      expect(response.status).toBe(200);
      expect(revocation).toBeDefined();
      await revocation;
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      expect((await me(request("/api/judge/me", undefined, cookie))).status).toBe(401);
      expect(proofHandle).not.toBe(f.db);
      expect(sessionHandle).toBe(proofHandle);
      expect((await join(request("/api/judge/join", { token }))).status).toBe(401);
    } finally {
      verificationSpy.mockRestore();
      sessionSpy.mockRestore();
    }
  });
  it("counts failed sign-ins durably and returns rate limit headers", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await login(
            request("/api/judge/login", {
              tournamentCode: f.tournament.joinCode,
              judgeCode: "BAD",
            }),
          )
        ).status,
      ).toBe(401);
    const response = await login(
      request("/api/judge/login", { tournamentCode: f.tournament.joinCode, judgeCode: "BAD" }),
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await f.db.select().from(rateLimits)).some((row) => row.tokens >= 6)).toBe(true);
  });
  it("rejects foreign origin on every mutation, invalid JSON, invalid shape and oversized body", async () => {
    const f = await fixture();
    for (const handler of [login, join, sheet, sync, heartbeat, logout])
      expect(
        (
          await handler(
            request("/api/judge/test", {}, f.cookie, { origin: "https://foreign.test" }),
          )
        ).status,
      ).toBe(403);
    const invalid = new Request("http://localhost:3000/api/judge/login", {
      method: "POST",
      body: "{",
      headers: { origin: "http://localhost:3000" },
    });
    expect((await login(invalid)).status).toBe(400);
    expect((await login(request("/api/judge/login", { tournamentCode: 10 }))).status).toBe(400);
    expect(
      (
        await login(
          new Request("http://localhost:3000/api/judge/login", {
            method: "POST",
            body: "x".repeat(256 * 1024 + 1),
          }),
        )
      ).status,
    ).toBe(413);
    const bytes = new TextEncoder().encode(JSON.stringify({ deviceId: "🦉é", statuses: [] }));
    const streamed = new Request("http://localhost:3000/api/judge/heartbeat", {
      method: "POST",
      headers: { cookie: f.cookie },
      body: new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect((await heartbeat(streamed)).status).toBe(200);
  });
  it("guards organiser live board by session and tournament organisation", async () => {
    const f = await fixture();
    const params = { params: Promise.resolve({ id: f.tournament.tournamentId }) };
    expect((await live(request("/api/t/live"), params)).status).toBe(401);
    const issued = await withTransaction(f.c, (tx) =>
      createUserSession(tx, f.c, f.tournament.userId),
    );
    const cookie = `dais.org=${issued.token}`;
    const response = await live(request("/api/t/live?round=1", undefined, cookie), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { tournamentId: f.tournament.tournamentId, round: 1 },
    });
    const other = await seedTournament(f.db);
    expect(
      (
        await live(request("/api/t/live", undefined, cookie), {
          params: Promise.resolve({ id: other.tournamentId }),
        })
      ).status,
    ).toBe(403);
  });
});
