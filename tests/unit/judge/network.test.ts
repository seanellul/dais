import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/judge/api";
import { JudgeSync } from "@/judge/sync";
import { JudgeStore } from "@/judge/store";
import { encodeHandoff, decodeHandoff, handoffComments } from "@/judge/handoff";
import { SCORE_FIELDS } from "@/domain/sheet/draft";
import { fixturePayload, judgeFixture } from "./fixtures";
const stores: JudgeStore[] = [];
const engines: JudgeSync[] = [];
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { ok: true, data } : data), {
    status,
    headers: { "x-dais": "1", "content-type": "application/json" },
  });
async function queued() {
  const store = new JudgeStore(`sync-${crypto.randomUUID()}`);
  stores.push(store);
  const bootstrap = judgeFixture();
  const { key } = await store.download(bootstrap);
  let draft = await store.draft(key, "asg_test");
  for (const [speakerId, score] of Object.entries(fixturePayload().scores))
    for (const field of [...SCORE_FIELDS, "www", "ebi"] as const)
      draft = await store.patch(key, "asg_test", draft.revision, {
        speakerId,
        field,
        value: score[field],
      });
  draft = await store.before(key, "asg_test", draft.revision);
  draft = await store.review(key, "asg_test", draft.revision);
  const item = await store.enqueue(key, "asg_test", draft.revision);
  const notice = vi.fn();
  const engine = new JudgeSync(store, key, vi.fn(), notice);
  engines.push(engine);
  return { store, bootstrap, key, item, engine, notice };
}
afterEach(async () => {
  engines.splice(0).forEach((e) => e.close());
  await Promise.all(stores.splice(0).map((s) => s.close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("judge transport and offline replay", () => {
  it("uses private no-store requests and preserves safe server errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        reply(
          { code: "unauthenticated", message: "Sign in again", retryable: false, requestId: "r1" },
          401,
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(api("/api/judge/sheets", { requestId: "stable" })).rejects.toMatchObject({
      status: 401,
      error: { code: "unauthenticated", requestId: "r1" },
    });
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      method: "POST",
    });
  });
  it("recognises captive portals, malformed JSON and lost connections without accepting receipts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("venue login", { headers: { "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        new Response("broken", { headers: { "x-dais": "1", "content-type": "application/json" } }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    for (let i = 0; i < 3; i++)
      await expect(api("/api/judge/me")).rejects.toMatchObject({
        error: { code: "connection", retryable: true },
      });
  });
  it("does not send with a cookie for another judge or while offline; recovers the same request after reload", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { store, bootstrap, key, item, engine, notice } = await queued();
    const wrong = structuredClone(bootstrap);
    wrong.judge.id = crypto.randomUUID();
    let mode = "wrong";
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (mode === "offline") throw new Error("offline");
        if (path === "/api/judge/me") return reply(mode === "wrong" ? wrong : bootstrap);
        if (path === "/api/judge/sheets") {
          const body = JSON.parse(String(init?.body));
          sent.push(body.requestId);
          return reply({ status: "received", version: 1, receivedAt: new Date().toISOString() });
        }
        return reply({ status: "ok" });
      }),
    );
    await engine.flush();
    expect(sent).toEqual([]);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("whose sheets"));
    mode = "offline";
    await engine.flush();
    expect((await store.get(key))?.outbox[item.requestId].state).toBe("queued");
    engine.close();
    const recovered = new JudgeSync(store, key, vi.fn(), notice);
    engines.push(recovered);
    mode = "good";
    await Promise.all([recovered.flush(), recovered.flush()]);
    expect(sent).toEqual([item.requestId]);
    expect((await store.get(key))?.outbox).toEqual({});
    expect((await store.get(key))?.receipts.asg_test.status).toBe("received");
  });
  it("persists retryable send failures and sends the same frozen request exactly once across tabs", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { store, bootstrap, key, item, engine } = await queued();
    let fail = true;
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/judge/me") return reply(bootstrap);
        if (path === "/api/judge/sheets") {
          sent.push(JSON.parse(String(init?.body)).requestId);
          if (fail) throw new Error("dropped");
          return reply({ status: "received", version: 1, receivedAt: new Date().toISOString() });
        }
        return reply({ status: "ok" });
      }),
    );
    await engine.flush();
    expect((await store.get(key))?.outbox[item.requestId]).toMatchObject({
      state: "queued",
      attempts: 1,
    });
    await store.retry(key, item.requestId);
    fail = false;
    const second = new JudgeSync(store, key, vi.fn(), vi.fn());
    engines.push(second);
    await Promise.all([engine.flush(), second.flush()]);
    expect(sent).toEqual([item.requestId, item.requestId]);
    expect((await store.get(key))?.outbox).toEqual({});
  });
});
describe("checked hand-off", () => {
  it("preserves identities, numbers, sides and role swaps, excludes comments and detects corruption", () => {
    const bootstrap = judgeFixture();
    const payload = fixturePayload();
    payload.sideFlipped = true;
    payload.roleSwaps[bootstrap.assignments[0].identity.governmentTeamId] = true;
    const input = {
      assignmentId: "asg_test",
      judgeId: bootstrap.judge.id,
      requestId: "stable",
      baseVersion: 2,
      payload,
    };
    const encoded = encodeHandoff(input);
    const decoded = decodeHandoff(encoded.text);
    expect(decoded).toEqual({
      ...input,
      payload: {
        ...payload,
        scores: Object.fromEntries(
          Object.entries(payload.scores).map(([id, score]) => [id, { ...score, www: "", ebi: "" }]),
        ),
      },
    });
    expect(encoded.code).toMatch(/^\d{6}$/);
    expect(atob(encoded.text.split(".")[2])).not.toContain("Clear examples");
    expect(() => decodeHandoff(encoded.text.replace(encoded.code, "999999"))).toThrow("check code");
    expect(() => decodeHandoff("123456")).toThrow("complete");
    expect(
      handoffComments(
        payload,
        Object.fromEntries(bootstrap.assignments[0].display.speakers.map((s) => [s.id, s.name])),
      ),
    ).toContain("Amara");
    expect(
      handoffComments(
        payload,
        Object.fromEntries(bootstrap.assignments[0].display.speakers.map((s) => [s.id, s.name])),
      ),
    ).toContain("Clear examples");
  });
});
