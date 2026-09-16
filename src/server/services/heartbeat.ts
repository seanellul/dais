/**
 * The judge device heartbeat.
 *
 * A judge's phone tells the server, every so often and whenever a sheet
 * changes state, what it is holding: which sheets are waiting to send. The
 * live board turns that into "waiting on the phone, last seen 2 min ago"
 * instead of "status unknown". The heartbeat is best-effort: a failure is
 * logged and reported back as `recorded: false`, never thrown, because a
 * phone must never stall on it.
 *
 * `judge_devices` stores the unsent sheet ids and per-sheet progress so
 * the organiser can see drafts and sheets that need attention.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { judgeDevices, judges, type JudgeDeviceRow } from "@/server/db";
import { errors, isAppError } from "@/server/errors";

import type { ServiceContext } from "./context";

/** What the phone says about one sheet. */
export type DeviceSheetState =
  "draft" | "queued" | "sending" | "conflict" | "attention" | "received";

export interface DeviceSheetStatus {
  assignmentId: string;
  state: DeviceSheetState;
  /** Fields filled in so far, for "13 of 20" on a draft. */
  filled?: number;
  /** ISO 8601. */
  updatedAt?: string;
}

export interface HeartbeatInput {
  judgeId: string;
  tournamentId: string;
  /** Random id the app generates once per install. */
  deviceId: string;
  /** What the phone believes; kept for the log only. */
  online?: boolean;
  appVersion?: string | null;
  userAgent?: string | null;
  statuses?: DeviceSheetStatus[];
}

export interface HeartbeatResult {
  recorded: boolean;
  /** ISO 8601, when recorded. */
  lastSeenAt?: string;
  /** Sheets the phone still has to send, as stored. */
  queuedCount?: number;
}

/** Sheets in these states are work the phone still has to get through. */
const UNSENT_STATES: ReadonlySet<DeviceSheetState> = new Set([
  "queued",
  "sending",
  "conflict",
  "attention",
]);

const heartbeatSchema = z.object({
  judgeId: z.uuid(),
  tournamentId: z.uuid(),
  deviceId: z.string().trim().min(1).max(128),
  online: z.boolean().optional(),
  appVersion: z.string().trim().max(64).nullish(),
  userAgent: z.string().trim().max(512).nullish(),
  statuses: z
    .array(
      z.object({
        assignmentId: z.string().trim().min(1).max(64),
        state: z.enum(["draft", "queued", "sending", "conflict", "attention", "received"]),
        filled: z.number().int().min(0).optional(),
        updatedAt: z.string().optional(),
      }),
    )
    .max(200)
    .default([]),
});

/**
 * Records a heartbeat: upserts the device row keyed by (tournament, judge,
 * device) with the time and the unsent sheet ids. Throws only `validation`
 * for a malformed body; every other failure is logged and reported as
 * `recorded: false`.
 */
export async function recordHeartbeat(
  ctx: ServiceContext,
  input: HeartbeatInput,
): Promise<HeartbeatResult> {
  const parsed = heartbeatSchema.safeParse(input);
  if (!parsed.success) {
    throw errors.validation("The heartbeat is not valid.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  }
  const beat = parsed.data;
  const queued = beat.statuses
    .filter((status) => UNSENT_STATES.has(status.state))
    .map((status) => status.assignmentId);
  const lastSeenAt = ctx.now();

  try {
    const [judge] = await ctx.db
      .select({ tournamentId: judges.tournamentId })
      .from(judges)
      .where(eq(judges.id, beat.judgeId))
      .limit(1);
    if (!judge || judge.tournamentId !== beat.tournamentId) {
      throw errors.forbidden("This judge is not part of this tournament.");
    }
    const row = await upsertDevice(ctx, beat, queued, lastSeenAt);
    ctx.log.debug(
      {
        judgeId: beat.judgeId,
        deviceId: beat.deviceId,
        queued: row.queuedCount,
        online: beat.online,
      },
      "Heartbeat recorded",
    );
    return { recorded: true, lastSeenAt: lastSeenAt.toISOString(), queuedCount: row.queuedCount };
  } catch (error) {
    if (isAppError(error) && error.code === "forbidden") throw error;
    ctx.log.warn(
      { err: error, judgeId: beat.judgeId, deviceId: beat.deviceId },
      "Heartbeat not recorded",
    );
    return { recorded: false };
  }
}

async function upsertDevice(
  ctx: ServiceContext,
  beat: z.infer<typeof heartbeatSchema>,
  queued: string[],
  lastSeenAt: Date,
): Promise<JudgeDeviceRow> {
  const values = {
    lastSeenAt,
    queuedCount: queued.length,
    queuedAssignmentIds: queued,
    statuses: beat.statuses,
    appVersion: beat.appVersion ?? null,
    userAgent: beat.userAgent ?? null,
  };
  const [row] = await ctx.db
    .insert(judgeDevices)
    .values({
      tournamentId: beat.tournamentId,
      judgeId: beat.judgeId,
      deviceId: beat.deviceId,
      createdAt: lastSeenAt,
      ...values,
    })
    .onConflictDoUpdate({
      target: [judgeDevices.tournamentId, judgeDevices.judgeId, judgeDevices.deviceId],
      set: values,
    })
    .returning();
  return row;
}

/** True when a device with unsent work has not spoken for longer than `silentAfterMs`. */
export function isSilent(
  device: Pick<JudgeDeviceRow, "lastSeenAt" | "queuedCount">,
  now: Date,
  silentAfterMs: number,
): boolean {
  return device.queuedCount > 0 && now.getTime() - device.lastSeenAt.getTime() > silentAfterMs;
}
