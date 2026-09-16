import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JudgeStore, workspaceKey } from "@/judge/store";
import { SCORE_FIELDS } from "@/domain/sheet/draft";
import { fixturePayload, fixtureSpeakerIds, judgeFixture } from "./fixtures";
const stores: JudgeStore[] = [];
async function setup() {
  const store = new JudgeStore(`test-${crypto.randomUUID()}`);
  stores.push(store);
  const bootstrap = judgeFixture();
  const workspace = await store.download(bootstrap);
  return { store, bootstrap, key: workspace.key };
}
async function reviewed(store: JudgeStore, key: string, id = "asg_test") {
  let draft = await store.draft(key, id);
  const payload = fixturePayload();
  for (const [speakerId, score] of Object.entries(payload.scores))
    for (const field of [...SCORE_FIELDS, "www", "ebi"] as const)
      draft = await store.patch(key, id, draft.revision, { speakerId, field, value: score[field] });
  draft = await store.before(key, id, draft.revision);
  return store.review(key, id, draft.revision);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
describe("persistent judge workspace invariants", () => {
  it("persists identities/drafts across reload, isolates judges and retains base versions across downloads", async () => {
    const { store, key, bootstrap } = await setup();
    expect((await store.active())?.key).toBe(workspaceKey(bootstrap));
    const draft = await store.draft(key, "asg_test");
    await store.patch(key, "asg_test", draft.revision, {
      speakerId: fixtureSpeakerIds[0],
      field: "overall",
      value: 80,
    });
    const newer = structuredClone(bootstrap);
    newer.assignments[0].current = {
      version: 3,
      payload: fixturePayload(),
      receivedAt: new Date().toISOString(),
    };
    await store.download(newer);
    expect((await store.draft(key, "asg_test")).baseVersion).toBe(0);
    expect(
      (await store.active())?.drafts.asg_test.payload.scores[fixtureSpeakerIds[0]].overall,
    ).toBe(80);
    const other = structuredClone(bootstrap);
    other.judge.id = crypto.randomUUID();
    await store.download(other);
    expect((await store.active())?.drafts).toEqual({});
    expect((await store.get(key))?.drafts.asg_test).toBeDefined();
    await store.signOut();
    expect(await store.active()).toBeUndefined();
    expect((await store.get(key))?.drafts.asg_test).toBeDefined();
  });
  it("rejects concurrent stale edits and validates speaker/team ownership", async () => {
    const { store, key } = await setup();
    const first = await store.draft(key, "asg_test");
    await store.patch(key, "asg_test", first.revision, {
      speakerId: fixtureSpeakerIds[0],
      field: "overall",
      value: 80,
    });
    await expect(
      store.patch(key, "asg_test", first.revision, {
        speakerId: fixtureSpeakerIds[0],
        field: "overall",
        value: 81,
      }),
    ).rejects.toMatchObject({ code: "changed" });
    await expect(
      store.patch(key, "asg_test", 1, { speakerId: "foreign", field: "overall", value: 80 }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      store.patch(key, "asg_test", 1, { teamId: "foreign", swapped: true }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(store.draft(key, "missing")).rejects.toMatchObject({ code: "missing" });
    await expect(store.patch(key, "missing", 0, { sideFlipped: true })).rejects.toMatchObject({
      code: "missing",
    });
    await expect(store.draft("missing", "asg_test")).rejects.toMatchObject({ code: "missing" });
  });
  it("saves sides/swaps/numeric deletion and requires before-score confirmation plus complete reviewed payload", async () => {
    const { store, key, bootstrap } = await setup();
    let draft = await store.draft(key, "asg_test");
    await expect(store.review(key, "asg_test", 0)).rejects.toMatchObject({ code: "invalid" });
    draft = await store.before(key, "asg_test", draft.revision);
    await expect(store.review(key, "asg_test", draft.revision)).rejects.toMatchObject({
      code: "invalid",
    });
    draft = await store.patch(key, "asg_test", draft.revision, { sideFlipped: true });
    expect(draft.beforeConfirmed).toBe(false);
    draft = await store.patch(key, "asg_test", draft.revision, {
      teamId: bootstrap.assignments[0].identity.governmentTeamId,
      swapped: true,
    });
    expect(draft.payload.roleSwaps).toMatchObject({
      [bootstrap.assignments[0].identity.governmentTeamId]: true,
    });
    draft = await store.patch(key, "asg_test", draft.revision, {
      speakerId: fixtureSpeakerIds[0],
      field: "overall",
      value: 0,
    });
    draft = await store.patch(key, "asg_test", draft.revision, {
      speakerId: fixtureSpeakerIds[0],
      field: "overall",
      value: null,
    });
    expect(draft.payload.scores[fixtureSpeakerIds[0]].overall).toBeUndefined();
    await expect(store.enqueue(key, "asg_test", draft.revision)).rejects.toMatchObject({
      code: "invalid",
    });
    draft = await reviewed(store, key);
    const strict = structuredClone(bootstrap);
    strict.tournament.feedbackRequired = true;
    await store.download(strict);
    draft = await store.patch(key, "asg_test", draft.revision, {
      speakerId: fixtureSpeakerIds[0],
      field: "www",
      value: "",
    });
    draft = await store.before(key, "asg_test", draft.revision);
    await expect(store.review(key, "asg_test", draft.revision)).rejects.toMatchObject({
      code: "invalid",
    });
  });
  it("freezes a queued revision, rejects duplicates and preserves its request ID across expired sends/reload", async () => {
    const { store, key } = await setup();
    const draft = await reviewed(store, key);
    const queued = await store.enqueue(key, "asg_test", draft.revision);
    await expect(store.enqueue(key, "asg_test", draft.revision)).rejects.toMatchObject({
      code: "frozen",
    });
    await expect(
      store.patch(key, "asg_test", draft.revision, { sideFlipped: true }),
    ).rejects.toMatchObject({ code: "frozen" });
    const first = await store.claim(key, "tab-a", 100);
    expect(first?.requestId).toBe(queued.requestId);
    expect(await store.claim(key, "tab-b", 101)).toBeNull();
    expect(await store.retry(key, queued.requestId)).toBe(false);
    await expect(store.edit(key, "asg_test")).rejects.toMatchObject({ code: "frozen" });
    const recovered = await store.claim(key, "tab-b", 45_101);
    expect(recovered?.requestId).toBe(queued.requestId);
    expect(recovered?.attempts).toBe(2);
    expect(
      await store.settle(
        key,
        queued.requestId,
        "tab-a",
        { status: "received", version: 1, receivedAt: "now" },
        45_102,
      ),
    ).toBe(false);
    expect(
      await store.settle(
        key,
        queued.requestId,
        "tab-b",
        { status: "received", version: 1, receivedAt: "now" },
        45_102,
      ),
    ).toBe(true);
    const workspace = await store.get(key);
    expect(workspace?.outbox).toEqual({});
    expect(workspace?.drafts).toEqual({});
    expect(workspace?.bootstrap.assignments[0].current?.payload).toEqual(fixturePayload());
    expect(await store.claim(key, "tab-a", 50_000)).toBeNull();
    expect(await store.retry(key, "absent")).toBe(false);
  });
  it("transitions connection/auth/conflict/stale/finalized failures with recoverable saved contents", async () => {
    const { store, key, bootstrap } = await setup();
    const draft = await reviewed(store, key);
    const queued = await store.enqueue(key, "asg_test", draft.revision);
    const failures = [
      { error: { code: "connection", message: "offline", retryable: true }, state: "queued" },
      { error: { code: "unauthenticated", message: "sign in", retryable: false }, state: "auth" },
      {
        error: {
          code: "assignment_retired",
          message: "new draw",
          retryable: false,
          details: { successorId: "new" },
        },
        state: "stale",
      },
      {
        error: { code: "division_finalized", message: "published", retryable: false },
        state: "attention",
      },
      {
        error: { code: "version_conflict", message: "two versions", retryable: false },
        state: "conflict",
      },
    ];
    for (const { error, state } of failures) {
      await store.retry(key, queued.requestId);
      await store.claim(key, "owner", 0);
      await store.settle(key, queued.requestId, "owner", error, 0);
      expect((await store.get(key))?.outbox[queued.requestId].state).toBe(state);
      expect((await store.get(key))?.drafts.asg_test.payload).toEqual(fixturePayload());
      expect(await store.claim(key, "owner", 1)).toBeNull();
      if (state === "auth") {
        await store.download(bootstrap);
        expect((await store.get(key))?.outbox[queued.requestId].state).toBe("queued");
      }
    }
    expect(await store.claim(key, "owner", 30_001)).toMatchObject({ requestId: queued.requestId });
    await store.settle(
      key,
      queued.requestId,
      "owner",
      { status: "conflict", kind: "comments_only", conflictId: "id", currentVersion: 1 },
      30_002,
    );
    expect((await store.get(key))?.outbox[queued.requestId].state).toBe("conflict");
  });
  it("never pretends quota failure saved a draft, queue or receipt", async () => {
    const { store, key } = await setup();
    const draft = await reviewed(store, key);
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
    await expect(store.enqueue(key, "asg_test", draft.revision)).rejects.toMatchObject({
      code: "storage",
    });
    expect((await store.get(key))?.outbox).toEqual({});
    await expect(
      store.patch(key, "asg_test", draft.revision, { sideFlipped: true }),
    ).rejects.toMatchObject({ code: "storage" });
    put.mockRestore();
    const queued = await store.enqueue(key, "asg_test", draft.revision);
    await store.claim(key, "owner", 0);
    const receiptPut = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
    await expect(
      store.settle(
        key,
        queued.requestId,
        "owner",
        { status: "received", version: 1, receivedAt: "now" },
        1,
      ),
    ).rejects.toMatchObject({ code: "storage" });
    expect((await store.get(key))?.outbox[queued.requestId]).toBeDefined();
    receiptPut.mockRestore();
  });
  it("retains old draw copies and copies only matching speakers into an explicit successor draft", async () => {
    const { store, key, bootstrap } = await setup();
    const draft = await reviewed(store, key);
    const queued = await store.enqueue(key, "asg_test", draft.revision);
    const next = structuredClone(bootstrap);
    next.assignments[0].id = "asg_new";
    next.assignments[0].identity.speakers[0].id = crypto.randomUUID();
    await store.download(next);
    expect(
      (await store.get(key))?.bootstrap.assignments.find((row) => row.id === "asg_test")?.retiredAt,
    ).toBeTruthy();
    expect((await store.get(key))?.outbox[queued.requestId].state).toBe("stale");
    await expect(store.successor(key, "asg_test")).rejects.toMatchObject({ code: "missing" });
    const old = structuredClone(bootstrap.assignments[0]);
    old.retiredAt = "now";
    old.successorId = "asg_new";
    next.assignments.push(old);
    await store.download(next);
    const copy = await store.successor(key, "asg_test");
    expect(copy.beforeConfirmed).toBe(false);
    expect(Object.keys(copy.payload.scores)).toHaveLength(3);
    expect(copy.payload.scores[fixtureSpeakerIds[0]]).toBeUndefined();
    expect((await store.get(key))?.drafts.asg_test).toBeDefined();
    await expect(store.successor(key, "asg_test")).rejects.toMatchObject({ code: "frozen" });
    const oldDraft = await store.edit(key, "asg_test");
    await expect(
      store.enqueue(
        key,
        "asg_test",
        (await store.review(key, "asg_test", oldDraft.revision)).revision,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("discards to a reversible tombstone, ignores delayed acknowledgements, and preserves request IDs on undo", async () => {
    const { store, key } = await setup();
    const draft = await reviewed(store, key);
    const queued = await store.enqueue(key, "asg_test", draft.revision);
    await store.claim(key, "owner", 0);
    const tombstone = await store.discard(key, "asg_test");
    expect((await store.get(key))?.tombstones[tombstone].submission?.requestId).toBe(
      queued.requestId,
    );
    expect(
      await store.settle(
        key,
        queued.requestId,
        "owner",
        { status: "received", version: 1, receivedAt: "now" },
        1,
      ),
    ).toBe(false);
    expect(await store.undo(key, tombstone)).toBe(true);
    expect((await store.get(key))?.outbox[queued.requestId].state).toBe("queued");
    expect(await store.undo(key, "missing")).toBe(false);
    const removed = await store.discard(key, "asg_test");
    await store.draft(key, "asg_test");
    await expect(store.undo(key, removed)).rejects.toMatchObject({ code: "frozen" });
  });
  it("creates an edited revision with a new request ID without letting old receipts erase it", async () => {
    const { store, key, bootstrap } = await setup();
    const draft = await reviewed(store, key);
    const old = await store.enqueue(key, "asg_test", draft.revision);
    await store.claim(key, "owner", 0);
    await store.settle(
      key,
      old.requestId,
      "owner",
      { code: "validation", message: "check", retryable: false },
      1,
    );
    const newer = structuredClone(bootstrap);
    newer.assignments[0].current = { version: 2, payload: fixturePayload(), receivedAt: "now" };
    await store.download(newer);
    let edited = await store.edit(key, "asg_test");
    expect(edited.baseVersion).toBe(2);
    edited = await store.review(key, "asg_test", edited.revision);
    const pending = await store.enqueue(key, "asg_test", edited.revision);
    expect(pending.requestId).not.toBe(old.requestId);
    expect(
      await store.settle(
        key,
        old.requestId,
        "owner",
        { status: "received", version: 1, receivedAt: "now" },
        2,
      ),
    ).toBe(false);
    expect((await store.get(key))?.outbox[pending.requestId]).toBeDefined();
    await expect(store.edit(key, "missing")).rejects.toMatchObject({ code: "missing" });
  });
  it("keeps authoritative organiser-selected content rather than claiming a kept receipt accepted phone values", async () => {
    const { store, key, bootstrap } = await setup();
    const draft = await reviewed(store, key);
    const item = await store.enqueue(key, "asg_test", draft.revision);
    const latest = structuredClone(bootstrap);
    const serverPayload = fixturePayload();
    serverPayload.scores[fixtureSpeakerIds[0]].overall = 81;
    latest.assignments[0].current = { version: 3, payload: serverPayload, receivedAt: "server" };
    await store.download(latest);
    await store.claim(key, "owner", 0);
    await store.settle(
      key,
      item.requestId,
      "owner",
      { status: "received", version: 3, receivedAt: "server", resolution: "keep" },
      1,
    );
    expect(
      (await store.get(key))?.bootstrap.assignments[0].current?.payload.scores[fixtureSpeakerIds[0]]
        .overall,
    ).toBe(81);
  });
  it("starts corrections from the current server version and rejects published-division sends", async () => {
    const { store, key, bootstrap } = await setup();
    const current = structuredClone(bootstrap);
    current.assignments[0].current = { version: 4, payload: fixturePayload(), receivedAt: "now" };
    current.assignments[0].divisionFinalized = true;
    await store.download(current);
    let draft = await store.draft(key, "asg_test");
    expect(draft.baseVersion).toBe(4);
    draft = await store.before(key, "asg_test", draft.revision);
    draft = await store.review(key, "asg_test", draft.revision);
    await expect(store.enqueue(key, "asg_test", draft.revision)).rejects.toMatchObject({
      code: "invalid",
    });
  });
  it("does not report a successful download if storage fails", async () => {
    const store = new JudgeStore(`test-${crypto.randomUUID()}`);
    stores.push(store);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new Error("write failed");
    });
    await expect(store.download(judgeFixture())).rejects.toMatchObject({ code: "storage" });
    expect(await store.active()).toBeUndefined();
  });
  it("preserves hand-off request IDs across reload and queueing; content changes get new IDs", async () => {
    const { store, key } = await setup();
    const first = await reviewed(store, key);
    expect((await store.get(key))?.drafts.asg_test.requestId).toBe(first.requestId);
    let changed = await store.patch(key, "asg_test", first.revision, {
      speakerId: fixtureSpeakerIds[0],
      field: "overall",
      value: 79,
    });
    expect(changed.requestId).not.toBe(first.requestId);
    changed = await store.review(key, "asg_test", changed.revision);
    const pending = await store.enqueue(key, "asg_test", changed.revision);
    expect(pending.requestId).toBe(changed.requestId);
  });
  it("retains kept-aside metadata across draw changes so undo remains possible", async () => {
    const { store, key, bootstrap } = await setup();
    await reviewed(store, key);
    const tombstone = await store.discard(key, "asg_test");
    const changed = structuredClone(bootstrap);
    changed.assignments = [];
    await store.download(changed);
    expect((await store.get(key))?.bootstrap.assignments[0].retiredAt).toBeTruthy();
    await store.undo(key, tombstone);
    expect((await store.get(key))?.drafts.asg_test).toBeDefined();
  });
  it("accepts untouched optional feedback as empty text while enforcing required feedback", async () => {
    const { store, key, bootstrap } = await setup();
    let draft = await store.draft(key, "asg_test");
    for (const [speakerId, score] of Object.entries(fixturePayload().scores))
      for (const field of SCORE_FIELDS)
        draft = await store.patch(key, "asg_test", draft.revision, {
          speakerId,
          field,
          value: score[field],
        });
    draft = await store.before(key, "asg_test", draft.revision);
    draft = await store.review(key, "asg_test", draft.revision);
    const item = await store.enqueue(key, "asg_test", draft.revision);
    expect(
      Object.values(item.payload.scores).every((score) => score.www === "" && score.ebi === ""),
    ).toBe(true);
    const other = structuredClone(bootstrap);
    other.judge.id = crypto.randomUUID();
    other.tournament.feedbackRequired = true;
    const next = await store.download(other);
    let required = await store.draft(next.key, "asg_test");
    for (const [speakerId, score] of Object.entries(fixturePayload().scores))
      for (const field of SCORE_FIELDS)
        required = await store.patch(next.key, "asg_test", required.revision, {
          speakerId,
          field,
          value: score[field],
        });
    required = await store.before(next.key, "asg_test", required.revision);
    await expect(store.review(next.key, "asg_test", required.revision)).rejects.toThrow(
      "Add What went well",
    );
  });
});
