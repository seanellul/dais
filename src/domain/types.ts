/**
 * Shared domain types. This file is the contract between the pure domain
 * modules (scoring, draw, schedule, rubric, sheet, import/export, sample) and
 * the server/client layers. Keep it free of framework and database types.
 *
 * Vocabulary: a *debater* is a person; a *team* is two debaters; a *debate*
 * is one room in one round with a Government and an Opposition team; an
 * *assignment* is one judge's slot on one debate and owns exactly one *sheet*.
 */

export type DivisionCode = string; // e.g. "Open", "Novice" — configurable per tournament
export type RoundFormat = "prepared" | "impromptu";
export type SidesDecided = "in-advance" | "in-room";
export type Side = "government" | "opposition";
export type SpeakerPosition = 1 | 2;
/** Speaking roles in a two-team parliamentary debate. */
export type RoleKey = "pm" | "lo" | "gm" | "om";
export type PanelMode = "fixed-room" | "per-round";

export interface DivisionSetting {
  code: DivisionCode;
  name: string;
}

export interface RoundSetting {
  number: number;
  format: RoundFormat;
  sidesDecided: SidesDecided;
}

export interface RubricCategory {
  key: "argumentation" | "rebuttal" | "presentation" | "poi";
  label: string;
  max: number;
}

export interface RubricBand {
  /** Inclusive lower bound of the overall score for this band. */
  min: number;
  /** Inclusive upper bound. */
  max: number;
  label: string; // "Excellent", "Very good", ...
  summary: string;
}

export interface Rubric {
  categories: RubricCategory[];
  overallMax: number;
  bands: RubricBand[];
  /** The Guide to Judging's quick value when no rebuttal is attempted. */
  noRebuttalScore: number;
  integersOnly: boolean;
  commentMaxLength: number;
}

export interface RoleLabels {
  pm: string;
  lo: string;
  gm: string;
  om: string;
}

/** Speech timings in minutes, in speaking order PM, LO, GM, OM, PM reply. */
export interface SpeechTimings {
  prepared: [number, number, number, number, number];
  impromptu: [number, number, number, number, number];
}

export interface TournamentSettings {
  divisions: DivisionSetting[];
  rounds: RoundSetting[];
  rubric: Rubric;
  roles: RoleLabels;
  timings: SpeechTimings;
  panelMode: PanelMode;
  judgesPerRoom: number;
  feedbackRequired: boolean;
}

export interface Speaker {
  id: string;
  name: string;
  position: SpeakerPosition;
}

export interface Team {
  id: string;
  divisionCode: DivisionCode;
  /** Short code used by the random draw, e.g. "O07". Unique per tournament. */
  code: string;
  name: string;
  school: string;
  /** Optional organiser-entered order for the seeded draw method. */
  seed?: number | null;
  speakers: Speaker[];
  status: "active" | "withdrawn";
}

export interface Judge {
  id: string;
  name: string;
  /** Fixed room for the whole day when panelMode is "fixed-room". */
  homeRoomId?: string | null;
  status: "active" | "withdrawn";
}

export interface Room {
  id: string;
  name: string;
  sortOrder: number;
}

export interface Debate {
  id: string;
  divisionCode: DivisionCode;
  round: number;
  roomId: string;
  governmentTeamId: string;
  oppositionTeamId: string;
  /** Judge ids on the panel, in seat order (1–5). */
  judgeIds: string[];
  motion: string;
}

/** Everything the draw, validation and assignment derivation need. */
export interface Schedule {
  settings: TournamentSettings;
  teams: Team[];
  judges: Judge[];
  rooms: Room[];
  debates: Debate[];
  /** Setup revision, bumped on every saved change. */
  revision: number;
}

/**
 * The matchup-defining fields of one judge's slot on one debate. Any change
 * here retires the assignment (its id changes); display-only fields do not.
 */
export interface AssignmentIdentity {
  debateId: string;
  divisionCode: DivisionCode;
  round: number;
  judgeId: string;
  governmentTeamId: string;
  oppositionTeamId: string;
  speakers: { id: string; teamId: string; side: Side; position: SpeakerPosition }[];
}

/** Refreshable, human-facing details shown on the judge's sheet. */
export interface AssignmentDisplay {
  roomName: string;
  judgeName: string;
  roundFormat: RoundFormat;
  sidesDecided: SidesDecided;
  motion: string;
  government: { teamId: string; code: string; name: string; school: string };
  opposition: { teamId: string; code: string; name: string; school: string };
  speakers: {
    id: string;
    name: string;
    teamId: string;
    side: Side;
    position: SpeakerPosition;
    role: RoleKey;
  }[];
}

export interface Assignment {
  id: string;
  identity: AssignmentIdentity;
  display: AssignmentDisplay;
  scheduleRevision: number;
  retiredAt?: string | null;
  retiredReason?: string | null;
  successorId?: string | null;
}

/** One speaker's marks on one judge's sheet. */
export interface SpeakerScore {
  argumentation: number;
  rebuttal: number;
  presentation: number;
  poi: number;
  /** The independent overall score out of 103; the number that counts. */
  overall: number;
  /** "What went well" */
  www: string;
  /** "Even better if" */
  ebi: string;
}

export type SheetScores = Record<string, SpeakerScore>; // keyed by speaker id

/** What a judge submits for one assignment. */
export interface SheetPayload {
  scores: SheetScores;
  /** True when the room's coin toss put the drawn Opposition on Government. */
  sideFlipped: boolean;
  /** teamId -> true when the two teammates swapped speaking roles. */
  roleSwaps: Record<string, boolean>;
}

export const DEFAULT_ROLE_LABELS: RoleLabels = {
  pm: "Prime Minister",
  lo: "Leader of the Opposition",
  gm: "Government Minister",
  om: "Opposition Member",
};
