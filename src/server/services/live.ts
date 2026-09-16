/**
 * The live board for one round: rooms × judge seats, each seat in one of
 * the states the organiser needs to act on.
 *
 * Server truth comes first (a stored sheet, two versions, a waiver), then
 * what the judge's phone last reported (waiting to send, silent). A seat is
 * "missing" only once the round is closed; while it is open the sheet is
 * simply not yet in. A sheet that belongs to an old draw shows as "old
 * draw" on its seat and goes in the unmatched tray, for the organiser to
 * re-attach, enter again or discard.
 *
 * Reads take no locks and the whole board is one graph load, so the 5 s poll
 * costs the same however many rooms there are.
 */
import { canonicalJson } from "@/domain/schedule";
import type { ActualSides, RoundRow } from "@/server/db";
import { errors } from "@/server/errors";

import type { Queryable } from "./context";
import { loadGraph, type GraphAssignment, type GraphSheet, type TournamentGraph } from "./graph";
import { isSilent } from "./heartbeat";

/** A phone that holds unsent work and has not spoken for this long is "silent". */
export const DEVICE_SILENT_AFTER_MS = 10 * 60 * 1000;

export type SeatState =
  | "not-yet-in"
  | "in-phone"
  | "in-paper"
  | "in-corrected"
  | "in-handoff"
  | "late"
  | "two-versions"
  | "missing"
  | "waived"
  | "old-draw"
  | "queued-on-phone"
  | "drafting"
  | "device-silent"
  | "needs-attention";

export interface LiveSeat {
  seat: number;
  judgeId: string;
  judgeName: string;
  /** Null when the draw has no live sheet for this seat yet. */
  assignmentId: string | null;
  state: SeatState;
  /** Fields filled in so far, when the phone reported a draft. */
  filled?: number;
  /** ISO 8601, when the judge's phone last spoke to the server. */
  lastSeenAt?: string;
  version?: number;
  /** ISO 8601, when the current version arrived. */
  receivedAt?: string;
  conflictId?: string;
}

export interface LiveTeam {
  teamId: string;
  code: string;
  name: string;
  school: string;
}

export interface LiveDebate {
  debateId: string;
  governmentTeam: LiveTeam;
  oppositionTeam: LiveTeam;
  motion: string;
  /** What the received sheets say about the coin toss, when they agree. */
  sidesRecorded?: "as-drawn" | "swapped";
  /** True when received sheets disagree about the sides. */
  disputed: boolean;
  /** The organiser's recorded decision about the sides, if any. */
  actualSides: ActualSides | null;
}

export interface LiveRoom {
  roomId: string;
  name: string;
  divisionCode: string;
  debate: LiveDebate;
  seats: LiveSeat[];
}

export interface LiveCounts {
  expected: number;
  received: number;
  notYetIn: number;
  needsAttention: number;
  twoVersions: number;
}

/** A sheet stored against a sheet slot the draw has since retired. */
export interface OrphanedSheet {
  assignmentId: string;
  judgeId: string;
  judgeName: string;
  roomName: string;
  divisionCode: string;
  round: number;
  version: number;
  /** ISO 8601. */
  receivedAt: string;
  /** ISO 8601. */
  retiredAt: string | null;
  retiredReason: string | null;
  successorId: string | null;
  /** True when the new sheet scores the same four debaters, so the scores can carry over. */
  speakersUnchanged: boolean;
}

export interface LiveBoard {
  tournamentId: string;
  round: number;
  roundStatus: RoundRow["status"];
  rooms: LiveRoom[];
  counts: LiveCounts;
  /** Sheets on old-draw slots, for the unmatched tray. */
  orphaned: OrphanedSheet[];
  /** ISO 8601, the server's clock when the board was built. */
  generatedAt: string;
}

export interface LiveBoardOptions {
  /** The clock; tests freeze it. */
  now?: Date;
}

/** Builds the live board for one round. Throws `not_found` for an unknown tournament or round. */
export async function liveBoard(
  db: Queryable,
  tournamentId: string,
  round: number,
  options: LiveBoardOptions = {},
): Promise<LiveBoard> {
  const graph = await loadGraph(db, tournamentId);
  return buildLiveBoard(graph, round, options.now ?? new Date());
}

/** The board from a loaded graph (pure). */
export function buildLiveBoard(graph: TournamentGraph, round: number, now: Date): LiveBoard {
  const roundRow = graph.rounds.find((row) => row.number === round);
  if (!roundRow) throw errors.notFound(`Round ${round}`);
  const index = new BoardIndex(graph, now);

  const rooms = graph.debates
    .filter((debate) => debate.round === round)
    .sort(
      (a, b) => index.roomOrder(a.roomId) - index.roomOrder(b.roomId) || a.id.localeCompare(b.id),
    )
    .map((debate) => index.room(debate, roundRow));

  return {
    tournamentId: graph.tournament.id,
    round,
    roundStatus: roundRow.status,
    rooms,
    counts: countSeats(rooms),
    orphaned: index.orphaned(round),
    generatedAt: now.toISOString(),
  };
}

const RECEIVED_STATES: ReadonlySet<SeatState> = new Set([
  "in-phone",
  "in-paper",
  "in-corrected",
  "in-handoff",
  "late",
]);
const WAITING_STATES: ReadonlySet<SeatState> = new Set([
  "not-yet-in",
  "queued-on-phone",
  "drafting",
  "device-silent",
  "missing",
]);
const ATTENTION_STATES: ReadonlySet<SeatState> = new Set([
  "needs-attention",
  "device-silent",
  "old-draw",
]);

function countSeats(rooms: LiveRoom[]): LiveCounts {
  const counts: LiveCounts = {
    expected: 0,
    received: 0,
    notYetIn: 0,
    needsAttention: 0,
    twoVersions: 0,
  };
  for (const room of rooms) {
    for (const seat of room.seats) {
      if (seat.assignmentId !== null) counts.expected += 1;
      if (RECEIVED_STATES.has(seat.state)) counts.received += 1;
      if (WAITING_STATES.has(seat.state)) counts.notYetIn += 1;
      if (ATTENTION_STATES.has(seat.state)) counts.needsAttention += 1;
      if (seat.state === "two-versions") counts.twoVersions += 1;
    }
  }
  return counts;
}

/** Lookups over the graph, built once per board. */
class BoardIndex {
  private readonly rooms = new Map(
    this.graph.rooms.map((room, i) => [room.id, { room, order: i }]),
  );
  private readonly teams = new Map(this.graph.teams.map((team) => [team.id, team]));
  private readonly judges = new Map(this.graph.judges.map((judge) => [judge.id, judge]));
  private readonly liveBySlot = new Map<string, GraphAssignment>();
  private readonly retiredBySlot = new Map<string, GraphAssignment[]>();
  private readonly byId = new Map<string, GraphAssignment>();
  private readonly sheets = new Map(this.graph.sheets.map((sheet) => [sheet.assignmentId, sheet]));
  private readonly openConflicts = new Map<string, string>();
  private readonly waived = new Set<string>();
  private readonly devices = new Map<string, TournamentGraph["judgeDevices"][number]>();

  constructor(
    private readonly graph: TournamentGraph,
    private readonly now: Date,
  ) {
    for (const assignment of graph.assignments) {
      this.byId.set(assignment.id, assignment);
      const key = `${assignment.debateId}:${assignment.judgeId}`;
      if (assignment.live) this.liveBySlot.set(key, assignment);
      else this.retiredBySlot.set(key, [...(this.retiredBySlot.get(key) ?? []), assignment]);
    }
    for (const conflict of graph.conflicts) {
      if (conflict.status === "open" && !this.openConflicts.has(conflict.assignmentId)) {
        this.openConflicts.set(conflict.assignmentId, conflict.id);
      }
    }
    for (const waiver of graph.sheetWaivers) {
      if (waiver.revokedAt === null) this.waived.add(waiver.assignmentId);
    }
    // One judge may have several installs; the one heard from last speaks for the judge.
    for (const device of graph.judgeDevices) {
      const known = this.devices.get(device.judgeId);
      if (!known || device.lastSeenAt > known.lastSeenAt) this.devices.set(device.judgeId, device);
    }
  }

  roomOrder(roomId: string): number {
    return this.rooms.get(roomId)?.order ?? Number.MAX_SAFE_INTEGER;
  }

  room(debate: TournamentGraph["debates"][number], round: RoundRow): LiveRoom {
    const seats = this.graph.debateJudges
      .filter((row) => row.debateId === debate.id)
      .sort((a, b) => a.seat - b.seat)
      .map((row) => this.seat(debate.id, row.judgeId, row.seat, round));
    return {
      roomId: debate.roomId,
      name: this.rooms.get(debate.roomId)?.room.name ?? "Unknown room",
      divisionCode: debate.divisionCode,
      debate: {
        debateId: debate.id,
        governmentTeam: this.team(debate.governmentTeamId),
        oppositionTeam: this.team(debate.oppositionTeamId),
        motion: debate.motion,
        ...this.sidesOf(seats),
        actualSides: debate.actualSides,
      },
      seats,
    };
  }

  private team(teamId: string): LiveTeam {
    const team = this.teams.get(teamId);
    return team
      ? { teamId, code: team.code, name: team.name, school: team.school }
      : { teamId, code: "", name: "Unknown team", school: "" };
  }

  /** The seat's state, in priority order: server truth, then the phone, then the clock. */
  private seat(debateId: string, judgeId: string, seatNumber: number, round: RoundRow): LiveSeat {
    const judge = this.judges.get(judgeId);
    const device = this.devices.get(judgeId);
    const base: LiveSeat = {
      seat: seatNumber,
      judgeId,
      judgeName: judge?.name ?? "Unknown judge",
      assignmentId: null,
      state: "not-yet-in",
      ...(device ? { lastSeenAt: device.lastSeenAt.toISOString() } : {}),
    };
    const key = `${debateId}:${judgeId}`;
    const oldSheet = (this.retiredBySlot.get(key) ?? []).some(
      (old) => this.sheets.has(old.id) && !this.sheets.get(old.id)?.orphanResolved,
    );
    const live = this.liveBySlot.get(key);
    if (!live) return { ...base, state: oldSheet ? "old-draw" : "not-yet-in" };
    const seat: LiveSeat = { ...base, assignmentId: live.id };

    const conflictId = this.openConflicts.get(live.id);
    if (conflictId !== undefined) return { ...seat, state: "two-versions", conflictId };
    const sheet = this.sheets.get(live.id);
    if (sheet) {
      return {
        ...seat,
        state: round.closedAt && sheet.receivedAt > round.closedAt ? "late" : receivedState(sheet),
        version: sheet.version,
        receivedAt: sheet.receivedAt.toISOString(),
      };
    }
    if (this.waived.has(live.id)) return { ...seat, state: "waived" };
    // A sheet exists for this seat, but for the old draw: the organiser
    // re-attaches it from the tray or enters it again on the live sheet.
    if (oldSheet) return { ...seat, state: "old-draw" };
    const phoneStatus = device?.statuses.find((status) => status.assignmentId === live.id);
    if (phoneStatus?.state === "attention" || phoneStatus?.state === "conflict") {
      return { ...seat, state: "needs-attention" };
    }
    if (phoneStatus?.state === "draft") {
      return {
        ...seat,
        state: "drafting",
        ...(phoneStatus.filled !== undefined ? { filled: phoneStatus.filled } : {}),
      };
    }
    if (device && device.queuedAssignmentIds.includes(live.id)) {
      const silent = isSilent(device, this.now, DEVICE_SILENT_AFTER_MS);
      return { ...seat, state: silent ? "device-silent" : "queued-on-phone" };
    }
    return { ...seat, state: round.status === "closed" ? "missing" : "not-yet-in" };
  }

  /** What the received sheets in the room say about the coin toss. */
  private sidesOf(seats: LiveSeat[]): Pick<LiveDebate, "sidesRecorded" | "disputed"> {
    const flips = new Set<boolean>();
    for (const seat of seats) {
      if (seat.assignmentId === null) continue;
      const sheet = this.sheets.get(seat.assignmentId);
      if (sheet) flips.add(sheet.sideFlipped);
    }
    if (flips.size === 0) return { disputed: false };
    if (flips.size > 1) return { disputed: true };
    return { sidesRecorded: flips.has(true) ? "swapped" : "as-drawn", disputed: false };
  }

  /** Sheets on retired slots in this round, for the unmatched tray. */
  orphaned(round: number): OrphanedSheet[] {
    const list: OrphanedSheet[] = [];
    for (const assignment of this.graph.assignments) {
      if (assignment.live || assignment.identity.round !== round) continue;
      const sheet = this.sheets.get(assignment.id);
      if (!sheet || sheet.orphanResolved) continue;
      const successor = assignment.successorId ? this.byId.get(assignment.successorId) : undefined;
      list.push({
        assignmentId: assignment.id,
        judgeId: assignment.judgeId,
        judgeName: assignment.display.judgeName,
        roomName: assignment.display.roomName,
        divisionCode: assignment.identity.divisionCode,
        round,
        version: sheet.version,
        receivedAt: sheet.receivedAt.toISOString(),
        retiredAt: assignment.retiredAt?.toISOString() ?? null,
        retiredReason: assignment.retiredReason,
        successorId: assignment.successorId,
        speakersUnchanged:
          successor !== undefined &&
          canonicalJson(successor.identity.speakers) ===
            canonicalJson(assignment.identity.speakers),
      });
    }
    return list;
  }
}

/** The "in" state for a stored sheet, by how its current version arrived. */
const RECEIVED_STATE_BY_SOURCE: Record<GraphSheet["source"], SeatState> = {
  judge: "in-phone",
  simulated: "in-phone",
  judge_handoff: "in-handoff",
  organiser_paper: "in-paper",
  import: "in-paper",
  organiser_correction: "in-corrected",
  organiser_resolution: "in-corrected",
};

function receivedState(sheet: GraphSheet): SeatState {
  return RECEIVED_STATE_BY_SOURCE[sheet.source];
}
