/**
 * Whole-tournament snapshots, taken before anything risky (publishing
 * results, reopening them, saving a draw over sheets, restoring a backup)
 * and on request. A snapshot is the full graph as JSON in one jsonb row, so
 * "what did the tournament look like before that click" is one query.
 *
 * The audit log is not part of a snapshot: it outlives the tournament and is
 * never restored over. The caller records the audit row for the operation
 * that asked for the snapshot.
 */
import { snapshotKindEnum, tournamentSnapshots } from "@/server/db";

import type { ServiceContext } from "./context";
import { loadGraph } from "./graph";
import type { Tx } from "@/server/db";

/** Why a snapshot was taken; the `snapshot_kind` enum. */
export type SnapshotKind = (typeof snapshotKindEnum.enumValues)[number];

/** The `format` field of every snapshot body, so a restore can refuse a stranger. */
export const SNAPSHOT_FORMAT = "dais-snapshot";
/** Bump when the body shape changes; a restore checks it. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface SnapshotOptions {
  /** A short label for the snapshots list, e.g. "Before publishing Open". */
  label?: string;
}

export interface SnapshotReceipt {
  id: string;
  /** Bytes of the JSON body as stored. */
  byteSize: number;
}

/**
 * Stores a snapshot of the tournament inside the caller's transaction and
 * returns its id and size. The body holds the complete graph: every
 * assignment (live and retired), every sheet version, every conflict
 * (including resolved), every override and waiver (including revoked).
 * Dates are ISO strings, as JSON makes them.
 */
export async function snapshotTournament(
  tx: Tx,
  ctx: ServiceContext,
  tournamentId: string,
  kind: SnapshotKind,
  options: SnapshotOptions = {},
): Promise<SnapshotReceipt> {
  const graph = await loadGraph(tx, tournamentId, {
    includeResolved: true,
    includeRevoked: true,
    includeVersions: true,
  });
  const takenAt = ctx.now();
  const text = JSON.stringify({
    format: SNAPSHOT_FORMAT,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    takenAt: takenAt.toISOString(),
    requestId: ctx.requestId,
    graph,
  });
  const byteSize = Buffer.byteLength(text, "utf8");
  const [row] = await tx
    .insert(tournamentSnapshots)
    .values({
      tournamentId,
      kind,
      label: options.label ?? null,
      // Parsing the text back gives plain JSON (no Date instances), so what is
      // stored is exactly what was measured.
      body: JSON.parse(text) as Record<string, unknown>,
      byteSize,
      createdAt: takenAt,
      createdBy: ctx.actor.name,
    })
    .returning({ id: tournamentSnapshots.id });
  ctx.log.info({ tournamentId, kind, snapshotId: row.id, byteSize }, "Tournament snapshot stored");
  return { id: row.id, byteSize };
}
