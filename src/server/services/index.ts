/**
 * The service layer's shared foundation. Feature services (teams, judges,
 * draw, sheets, results, backup, demo) build on these:
 *
 *   import { withTransaction, recordAudit, AUDIT_ACTIONS, loadGraph } from "@/server/services";
 */
export {
  SYSTEM_ACTOR,
  createContext,
  isUniqueViolation,
  sqlStateOf,
  withTransaction,
  type Actor,
  type ActorType,
  type ContextInit,
  type Queryable,
  type ServiceContext,
} from "./context";

export {
  AUDIT_ACTIONS,
  AUDIT_ACTIONS_REQUIRING_REASON,
  actorTypeOf,
  diffOf,
  recordAudit,
  type AuditAction,
  type AuditEntry,
} from "./audit";

export {
  CROCKFORD_ALPHABET,
  CROCKFORD_LETTERS,
  JOIN_CODE_PATTERN,
  crockfordCode,
  fingerprintOf,
  hashToken,
  joinCode,
  newId,
  normaliseCode,
  randomToken,
  sha256Hex,
} from "./ids";

export { run, type ServiceResult } from "./result";

export {
  DEFAULT_TOP_N,
  loadGraph,
  scoreOriginOf,
  settingsOf,
  toDivisionInput,
  toSchedule,
  type GraphAssignment,
  type GraphSheet,
  type LoadGraphOptions,
  type TournamentGraph,
} from "./graph";

export {
  SNAPSHOT_FORMAT,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotTournament,
  type SnapshotKind,
  type SnapshotOptions,
  type SnapshotReceipt,
} from "./snapshots";
