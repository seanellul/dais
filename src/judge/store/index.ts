import { withBlankFeedback } from "./feedback";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { parseSheetPayload } from "@/domain/sheet/schema";
import type { JudgeBootstrap, JudgeReceipt } from "@/judge/api-types";
import type { DraftPatch, LocalDraft, LocalError, Submission, Tombstone, Workspace } from "./types";
import { StoreError } from "./types";
export * from "./types";

interface JudgeDatabase extends DBSchema {
  workspaces: { key: string; value: Workspace };
  meta: { key: string; value: string };
}
const nowText = () => new Date().toISOString();
export const workspaceKey = (bootstrap: JudgeBootstrap) =>
  `${bootstrap.tournament.id}:${bootstrap.judge.id}`;
export class JudgeStore {
  private db: Promise<IDBPDatabase<JudgeDatabase>>;
  constructor(name = "dais-judge-v1") {
    this.db = openDB<JudgeDatabase>(name, 1, {
      upgrade(db) {
        db.createObjectStore("workspaces", { keyPath: "key" });
        db.createObjectStore("meta");
      },
    });
  }
  async close() {
    (await this.db).close();
  }
  async get(key: string): Promise<Workspace | undefined> {
    return (await this.db).get("workspaces", key);
  }
  async active(): Promise<Workspace | undefined> {
    const key = await (await this.db).get("meta", "active");
    return key ? this.get(key) : undefined;
  }
  async signOut() {
    await (await this.db).delete("meta", "active");
  }
  private async change<T>(key: string, operation: (workspace: Workspace) => T): Promise<T> {
    const tx = (await this.db).transaction("workspaces", "readwrite");
    try {
      const workspace = await tx.store.get(key);
      if (!workspace) throw new StoreError("missing", "Sign in and download your sheets first.");
      const result = operation(workspace);
      workspace.updatedAt = nowText();
      await tx.store.put(workspace);
      await tx.done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* A storage failure may already abort it. */
      }
      await tx.done.catch(() => undefined);
      if (error instanceof StoreError) throw error;
      throw new StoreError(
        "storage",
        "This phone could not save your sheet. Keep this screen open and hand it to the organiser.",
      );
    }
  }
  async download(bootstrap: JudgeBootstrap): Promise<Workspace> {
    const key = workspaceKey(bootstrap);
    const tx = (await this.db).transaction(["workspaces", "meta"], "readwrite");
    try {
      const previous = await tx.objectStore("workspaces").get(key);
      const workspace: Workspace = previous ?? {
        key,
        bootstrap,
        drafts: {},
        outbox: {},
        receipts: {},
        tombstones: {},
        deviceId: crypto.randomUUID(),
        updatedAt: nowText(),
      };
      const ids = new Set(bootstrap.assignments.map((row) => row.id));
      const retained = workspace.bootstrap.assignments
        .filter(
          (row) =>
            !ids.has(row.id) &&
            (workspace.drafts[row.id] ||
              Object.values(workspace.outbox).some((item) => item.assignmentId === row.id) ||
              Object.values(workspace.tombstones).some((item) => item.assignmentId === row.id)),
        )
        .map((row) => ({ ...row, retiredAt: row.retiredAt ?? nowText() }));
      workspace.bootstrap = { ...bootstrap, assignments: [...bootstrap.assignments, ...retained] };
      // A newer download must never change the base version of a local draft.
      for (const item of Object.values(workspace.outbox)) {
        const row = workspace.bootstrap.assignments.find((row) => row.id === item.assignmentId);
        if (row?.retiredAt && item.state !== "sending") {
          item.state = "stale";
          item.error = {
            code: "assignment_retired",
            message: "The draw changed. Your old sheet is still saved on this phone.",
            retryable: false,
            details: { successorId: row.successorId },
          };
        } else if (item.state === "auth") {
          item.state = "queued";
          item.nextAttemptAt = 0;
        }
      }
      workspace.updatedAt = nowText();
      await tx.objectStore("workspaces").put(workspace);
      await tx.objectStore("meta").put(key, "active");
      await tx.done;
      return workspace;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already aborted. */
      }
      await tx.done.catch(() => undefined);
      throw error instanceof StoreError
        ? error
        : new StoreError("storage", "This phone could not save your downloaded sheets.");
    }
  }
  async draft(key: string, assignmentId: string): Promise<LocalDraft> {
    return this.change(key, (workspace) => {
      const row = workspace.bootstrap.assignments.find((row) => row.id === assignmentId);
      if (!row) throw new StoreError("missing", "That sheet is not on this phone.");
      const existing = workspace.drafts[assignmentId];
      if (existing) return existing;
      const current = row.current;
      const draft: LocalDraft = {
        assignmentId,
        requestId: crypto.randomUUID(),
        baseVersion: current?.version ?? 0,
        revision: 0,
        payload: current
          ? structuredClone(current.payload)
          : { scores: {}, sideFlipped: false, roleSwaps: {} },
        beforeConfirmed: false,
        reviewed: false,
        updatedAt: nowText(),
      };
      workspace.drafts[assignmentId] = draft;
      return draft;
    });
  }
  private editable(workspace: Workspace, id: string, revision: number): LocalDraft {
    if (Object.values(workspace.outbox).some((item) => item.assignmentId === id))
      throw new StoreError(
        "frozen",
        "This reviewed sheet is waiting to send. Choose Edit and resubmit to change it.",
      );
    const draft = workspace.drafts[id];
    if (!draft) throw new StoreError("missing", "Open the sheet before editing it.");
    if (draft.revision !== revision)
      throw new StoreError(
        "changed",
        "Another window changed this sheet. Reopen it to see the saved version.",
      );
    return draft;
  }
  async patch(key: string, id: string, revision: number, patch: DraftPatch): Promise<LocalDraft> {
    return this.change(key, (workspace) => {
      const draft = this.editable(workspace, id, revision);
      const row = workspace.bootstrap.assignments.find((row) => row.id === id)!;
      if ("speakerId" in patch) {
        if (!row.identity.speakers.some((speaker) => speaker.id === patch.speakerId))
          throw new StoreError("invalid", "That debater is not on this sheet.");
        const score = draft.payload.scores[patch.speakerId] ?? {};
        if (patch.value === null) delete score[patch.field];
        else Object.assign(score, { [patch.field]: patch.value });
        draft.payload.scores[patch.speakerId] = score;
      } else if ("sideFlipped" in patch) {
        draft.payload.sideFlipped = patch.sideFlipped;
        draft.beforeConfirmed = false;
      } else {
        if (![row.identity.governmentTeamId, row.identity.oppositionTeamId].includes(patch.teamId))
          throw new StoreError("invalid", "That team is not on this sheet.");
        draft.payload.roleSwaps[patch.teamId] = patch.swapped;
        draft.beforeConfirmed = false;
      }
      draft.revision++;
      // Changed content must not reuse an already shared hand-off request.
      draft.requestId = crypto.randomUUID();
      draft.reviewed = false;
      draft.updatedAt = nowText();
      return draft;
    });
  }
  async before(key: string, id: string, revision: number): Promise<LocalDraft> {
    return this.change(key, (workspace) => {
      const draft = this.editable(workspace, id, revision);
      draft.beforeConfirmed = true;
      draft.revision++;
      return draft;
    });
  }
  async review(key: string, id: string, revision: number): Promise<LocalDraft> {
    return this.change(key, (workspace) => {
      const draft = this.editable(workspace, id, revision);
      this.complete(workspace, draft);
      draft.reviewed = true;
      draft.revision++;
      return draft;
    });
  }
  private complete(workspace: Workspace, draft: LocalDraft) {
    if (!draft.beforeConfirmed)
      throw new StoreError("invalid", "Confirm sides and speaking roles before reviewing.");
    const row = workspace.bootstrap.assignments.find((row) => row.id === draft.assignmentId)!;
    const parsed = parseSheetPayload(withBlankFeedback(draft.payload), {
      rubric: workspace.bootstrap.tournament.rubric,
      speakerIds: row.identity.speakers.map((speaker) => speaker.id),
      teamIds: [row.identity.governmentTeamId, row.identity.oppositionTeamId],
    });
    if (!parsed.ok)
      throw new StoreError(
        "invalid",
        "Fill in all four debaters' scores within the rubric ranges before reviewing.",
      );
    if (
      workspace.bootstrap.tournament.feedbackRequired &&
      Object.values(parsed.data.scores).some((score) => !score.www || !score.ebi)
    )
      throw new StoreError("invalid", "Add What went well and Even better if for each debater.");
    return parsed.data;
  }
  async enqueue(key: string, id: string, revision: number): Promise<Submission> {
    return this.change(key, (workspace) => {
      const draft = this.editable(workspace, id, revision);
      if (!draft.reviewed) throw new StoreError("invalid", "Review this sheet before sending it.");
      const row = workspace.bootstrap.assignments.find((row) => row.id === id)!;
      if (row.retiredAt || row.divisionFinalized)
        throw new StoreError(
          "invalid",
          row.retiredAt
            ? "The draw changed. Open the new sheet or hand off this saved copy."
            : "Results are published. Ask the organiser to reopen them.",
        );
      const item: Submission = {
        assignmentId: id,
        requestId: draft.requestId,
        baseVersion: draft.baseVersion,
        payload: this.complete(workspace, draft),
        state: "queued",
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: nowText(),
      };
      workspace.outbox[item.requestId] = item;
      return item;
    });
  }
  async claim(key: string, owner: string, now: number): Promise<Submission | null> {
    return this.change(key, (workspace) => {
      const pending = Object.values(workspace.outbox);
      if (pending.some((item) => item.state === "sending" && (item.leaseUntil ?? 0) > now))
        return null;
      const item = pending.find(
        (item) =>
          (["queued", "conflict"].includes(item.state) && item.nextAttemptAt <= now) ||
          (item.state === "sending" && (item.leaseUntil ?? 0) <= now),
      );
      if (!item) return null;
      item.state = "sending";
      item.owner = owner;
      item.leaseUntil = now + 45_000;
      item.attempts++;
      return item;
    });
  }
  async settle(
    key: string,
    requestId: string,
    owner: string,
    result: JudgeReceipt | LocalError,
    now: number,
  ) {
    return this.change(key, (workspace) => {
      const item = workspace.outbox[requestId];
      // Ignore delayed receipts for discarded/replaced requests or expired owners.
      if (!item || item.owner !== owner || item.state !== "sending") return false;
      delete item.owner;
      delete item.leaseUntil;
      if ("status" in result && result.status === "received") {
        workspace.receipts[item.assignmentId] = result;
        delete workspace.outbox[requestId];
        delete workspace.drafts[item.assignmentId];
        const row = workspace.bootstrap.assignments.find((row) => row.id === item.assignmentId);
        // Keep downloaded organiser-selected content, rather than an old phone payload.
        if (
          row &&
          (!result.resolution || result.resolution === "incoming") &&
          (!row.current || row.current.version < result.version)
        )
          row.current = {
            version: result.version,
            payload: item.payload,
            receivedAt: result.receivedAt,
          };
      } else {
        const error: LocalError =
          "status" in result
            ? {
                code: "version_conflict",
                message: "Two versions are with the organiser. Your sheet is saved.",
                retryable: false,
                details: { receipt: result },
              }
            : result;
        item.error = error;
        item.state =
          error.code === "unauthenticated"
            ? "auth"
            : error.code === "assignment_retired"
              ? "stale"
              : error.code === "version_conflict"
                ? "conflict"
                : error.retryable
                  ? "queued"
                  : "attention";
        item.nextAttemptAt =
          now +
          (item.state === "conflict"
            ? 30_000
            : Math.min(60_000, 1000 * 2 ** Math.min(item.attempts, 6)));
      }
      return true;
    });
  }
  async retry(key: string, requestId: string) {
    return this.change(key, (workspace) => {
      const item = workspace.outbox[requestId];
      if (!item) return false;
      if (item.state === "sending") return false;
      item.state = "queued";
      item.nextAttemptAt = 0;
      return true;
    });
  }
  async discard(key: string, id: string): Promise<string> {
    return this.change(key, (workspace) => {
      const item = Object.values(workspace.outbox).find((item) => item.assignmentId === id);
      const tombstone: Tombstone = {
        id: crypto.randomUUID(),
        assignmentId: id,
        draft: workspace.drafts[id],
        submission: item,
        discardedAt: nowText(),
      };
      workspace.tombstones[tombstone.id] = tombstone;
      delete workspace.drafts[id];
      if (item) delete workspace.outbox[item.requestId];
      return tombstone.id;
    });
  }
  async undo(key: string, tombstoneId: string) {
    return this.change(key, (workspace) => {
      const tombstone = workspace.tombstones[tombstoneId];
      if (!tombstone) return false;
      if (
        workspace.drafts[tombstone.assignmentId] ||
        Object.values(workspace.outbox).some((item) => item.assignmentId === tombstone.assignmentId)
      )
        throw new StoreError(
          "frozen",
          "Another saved version exists. Keep it before restoring the old copy.",
        );
      if (tombstone.draft) workspace.drafts[tombstone.assignmentId] = tombstone.draft;
      if (tombstone.submission) {
        const item = tombstone.submission;
        item.state = "queued";
        item.nextAttemptAt = 0;
        delete item.owner;
        delete item.leaseUntil;
        workspace.outbox[item.requestId] = item;
      }
      delete workspace.tombstones[tombstoneId];
      return true;
    });
  }
  async edit(key: string, id: string): Promise<LocalDraft> {
    return this.change(key, (workspace) => {
      const item = Object.values(workspace.outbox).find((item) => item.assignmentId === id);
      if (item?.state === "sending")
        throw new StoreError("frozen", "Wait for this send to finish before editing.");
      if (item) {
        const tombstoneId = crypto.randomUUID();
        workspace.tombstones[tombstoneId] = {
          id: tombstoneId,
          assignmentId: id,
          submission: item,
          draft: workspace.drafts[id],
          discardedAt: nowText(),
        };
        delete workspace.outbox[item.requestId];
      }
      const row = workspace.bootstrap.assignments.find((row) => row.id === id);
      const draft = workspace.drafts[id];
      if (!draft || !row) throw new StoreError("missing", "That saved sheet is unavailable.");
      draft.baseVersion = row.current?.version ?? 0;
      draft.requestId = crypto.randomUUID();
      draft.reviewed = false;
      draft.revision++;
      return draft;
    });
  }
  async successor(key: string, id: string): Promise<LocalDraft> {
    return this.change(key, (workspace) => {
      const old = workspace.bootstrap.assignments.find((row) => row.id === id);
      const next = workspace.bootstrap.assignments.find((row) => row.id === old?.successorId);
      const oldDraft = workspace.drafts[id];
      if (!oldDraft || !next || next.retiredAt)
        throw new StoreError(
          "missing",
          "Download the new draw, or ask the organiser which sheet to use.",
        );
      if (
        workspace.drafts[next.id] ||
        Object.values(workspace.outbox).some((item) => item.assignmentId === next.id)
      )
        throw new StoreError(
          "frozen",
          "The new sheet already has saved work. Open it to review that copy.",
        );
      const scores = Object.fromEntries(
        next.identity.speakers
          .filter((speaker) => oldDraft.payload.scores[speaker.id])
          .map((speaker) => [speaker.id, oldDraft.payload.scores[speaker.id]]),
      );
      const swaps = Object.fromEntries(
        [next.identity.governmentTeamId, next.identity.oppositionTeamId]
          .filter((teamId) => teamId in oldDraft.payload.roleSwaps)
          .map((teamId) => [teamId, oldDraft.payload.roleSwaps[teamId]]),
      );
      const draft: LocalDraft = {
        assignmentId: next.id,
        requestId: crypto.randomUUID(),
        baseVersion: next.current?.version ?? 0,
        revision: 0,
        payload: { scores, sideFlipped: oldDraft.payload.sideFlipped, roleSwaps: swaps },
        beforeConfirmed: false,
        reviewed: false,
        updatedAt: nowText(),
      };
      workspace.drafts[next.id] = draft;
      return draft;
    });
  }
}
