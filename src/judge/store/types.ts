import type { JudgeBootstrap, JudgeReceipt } from "@/judge/api-types";
import type { DraftSpeakerScore } from "@/domain/sheet/draft";
import type { SheetPayload } from "@/domain/types";

export type LocalState =
  "queued" | "sending" | "received" | "conflict" | "stale" | "attention" | "auth";
export interface LocalPayload {
  scores: Record<string, DraftSpeakerScore>;
  sideFlipped: boolean;
  roleSwaps: Record<string, boolean>;
}
export interface LocalDraft {
  assignmentId: string;
  requestId: string;
  baseVersion: number;
  revision: number;
  payload: LocalPayload;
  beforeConfirmed: boolean;
  reviewed: boolean;
  updatedAt: string;
}
export interface LocalError {
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
  details?: Record<string, unknown>;
}
export interface Submission {
  assignmentId: string;
  requestId: string;
  baseVersion: number;
  payload: SheetPayload;
  state: LocalState;
  attempts: number;
  nextAttemptAt: number;
  owner?: string;
  leaseUntil?: number;
  error?: LocalError;
  receipt?: JudgeReceipt;
  createdAt: string;
}
export interface Tombstone {
  id: string;
  assignmentId: string;
  draft?: LocalDraft;
  submission?: Submission;
  discardedAt: string;
}
export interface Workspace {
  key: string;
  bootstrap: JudgeBootstrap;
  drafts: Record<string, LocalDraft>;
  outbox: Record<string, Submission>;
  receipts: Record<string, JudgeReceipt>;
  tombstones: Record<string, Tombstone>;
  deviceId: string;
  updatedAt: string;
}
export type DraftPatch =
  | { speakerId: string; field: keyof DraftSpeakerScore; value: number | string | null }
  | { sideFlipped: boolean }
  | { teamId: string; swapped: boolean };
export class StoreError extends Error {
  constructor(
    public readonly code: "storage" | "changed" | "frozen" | "missing" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}
