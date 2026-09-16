import type { JudgeBootstrap, JudgeReceipt } from "@/judge/api-types";
import { api, JudgeApiError } from "@/judge/api";
import { JudgeStore, type Workspace } from "@/judge/store";

export class JudgeSync {
  private owner = crypto.randomUUID();
  private running = false;
  private channel: BroadcastChannel | undefined;
  private disposed = false;
  constructor(
    private store: JudgeStore,
    private key: string,
    private changed: () => void,
    private notice: (message: string) => void,
  ) {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("dais-judge");
      this.channel.onmessage = (event) => {
        if (event.data?.key === key) changed();
      };
    }
  }
  broadcast() {
    this.channel?.postMessage({ key: this.key });
    this.changed();
  }
  close() {
    this.disposed = true;
    this.channel?.close();
  }
  async refresh(): Promise<Workspace> {
    const bootstrap = await api<JudgeBootstrap>("/api/judge/me");
    const workspace = await this.store.get(this.key);
    if (
      !workspace ||
      bootstrap.judge.id !== workspace.bootstrap.judge.id ||
      bootstrap.tournament.id !== workspace.bootstrap.tournament.id
    )
      throw new JudgeApiError(
        {
          code: "unauthenticated",
          message: "Sign in as the judge whose sheets are saved on this phone before sending them.",
          retryable: false,
        },
        401,
      );
    const result = await this.store.download(bootstrap);
    this.broadcast();
    return result;
  }
  async heartbeat() {
    const workspace = await this.store.get(this.key);
    if (!workspace || this.disposed) return;
    const submissions = new Map(
      Object.values(workspace.outbox).map((item) => [item.assignmentId, item]),
    );
    const statuses = Object.values(workspace.drafts)
      .slice(0, 200)
      .map((draft) => {
        const item = submissions.get(draft.assignmentId);
        const state =
          item?.state === "sending"
            ? "sending"
            : item?.state === "conflict"
              ? "conflict"
              : item?.state === "queued"
                ? "queued"
                : item
                  ? "attention"
                  : "draft";
        const filled = Object.values(draft.payload.scores).reduce(
          (count, score) =>
            count +
            [
              score.argumentation,
              score.rebuttal,
              score.presentation,
              score.poi,
              score.overall,
            ].filter((value) => typeof value === "number").length,
          0,
        );
        return { assignmentId: draft.assignmentId, state, filled, updatedAt: draft.updatedAt };
      });
    try {
      await api("/api/judge/heartbeat", {
        deviceId: workspace.deviceId,
        online: navigator.onLine,
        appVersion: "1",
        statuses,
      });
    } catch {
      /* Heartbeats must never stall saved work. */
    }
  }
  async flush() {
    if (this.running || this.disposed) return;
    this.running = true;
    const flush = async () => {
      try {
        await api("/api/health");
        // Authenticate the current cookie against this workspace before any replay.
        await this.refresh();
        for (let count = 0; count < 20 && !this.disposed; count++) {
          const item = await this.store.claim(this.key, this.owner, Date.now());
          if (!item) break;
          this.broadcast();
          try {
            const receipt = await api<JudgeReceipt>("/api/judge/sheets", {
              assignmentId: item.assignmentId,
              requestId: item.requestId,
              baseVersion: item.baseVersion,
              payload: item.payload,
            });
            await this.store.settle(this.key, item.requestId, this.owner, receipt, Date.now());
          } catch (error) {
            const failure =
              error instanceof JudgeApiError
                ? error.error
                : {
                    code: "connection",
                    message: "Waiting for connection. Your sheet remains saved.",
                    retryable: true,
                  };
            await this.store.settle(this.key, item.requestId, this.owner, failure, Date.now());
            if (failure.retryable || failure.code === "unauthenticated") break;
          }
          this.broadcast();
        }
        await this.refresh();
        await this.heartbeat();
      } catch (error) {
        if (error instanceof JudgeApiError) this.notice(error.message);
        else
          this.notice(
            error instanceof Error
              ? error.message
              : "This phone could not save the send result. Keep the saved sheet and retry.",
          );
      } finally {
        this.broadcast();
      }
    };
    try {
      if (navigator.locks)
        await navigator.locks.request(
          `dais-judge-flush:${this.key}`,
          { ifAvailable: true },
          (lock) => (lock ? flush() : Promise.resolve()),
        );
      else await flush(); // IndexedDB claim leases also serialize browsers without Web Locks.
    } finally {
      this.running = false;
    }
  }
}
