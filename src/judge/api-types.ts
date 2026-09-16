import type {
  AssignmentDisplay,
  AssignmentIdentity,
  Rubric,
  SheetPayload,
  SpeechTimings,
  RoleLabels,
} from "@/domain/types";

export interface JudgeAssignment {
  id: string;
  identity: AssignmentIdentity;
  display: AssignmentDisplay;
  retiredAt: string | null;
  successorId: string | null;
  divisionFinalized: boolean;
  roundStatus: string;
  current: { version: number; payload: SheetPayload; receivedAt: string } | null;
  openConflict: boolean;
}

export interface JudgeBootstrap {
  judge: { id: string; name: string; homeRoomName: string | null };
  tournament: {
    id: string;
    name: string;
    slug: string;
    contact: string | null;
    rubric: Rubric;
    timings?: SpeechTimings;
    roles?: RoleLabels;
    feedbackRequired?: boolean;
  };
  assignments: JudgeAssignment[];
}

export type JudgeReceipt =
  | {
      status: "received";
      version: number;
      receivedAt: string;
      absorbed?: boolean;
      resolution?: "incoming" | "keep" | "merge_comments";
    }
  | {
      status: "conflict";
      kind: "version" | "comments_only";
      conflictId: string;
      currentVersion: number;
    };

export interface JudgeReceiptResponse {
  ok: true;
  data: JudgeReceipt;
}
