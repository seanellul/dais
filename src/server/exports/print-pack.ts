import QRCode from "qrcode";
import { drawRows, feedbackRows, itineraryRows } from "@/domain/export";
import { errors } from "@/server/errors";
import { joinLinkFor, joinTokenFor } from "@/server/auth/tokens";
import { toSchedule, type TournamentGraph } from "@/server/services/graph";
import { buildResultsView } from "@/server/services/results";
import { exportRecords } from "./data";

export const PRINT_KINDS = [
  "doors",
  "itineraries",
  "judges",
  "scoresheets",
  "feedback",
  "results",
] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];
export interface PrintSection {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: string[][];
  notes: string[];
  qr?: string;
}
export interface PrintPack {
  tournament: string;
  title: string;
  kind: PrintKind;
  practice: boolean;
  generatedAt: string;
  sections: PrintSection[];
}
const number = (value: number | null) =>
  value === null ? "—" : Number(value.toFixed(2)).toString();

export async function buildPrintPack(
  graph: TournamentGraph,
  kind: PrintKind,
  division?: string,
): Promise<PrintPack> {
  if (division && !graph.divisions.some((row) => row.code === division))
    throw errors.notFound("That division");
  const schedule = toSchedule(graph);
  const records = exportRecords(graph).filter(
    (row) => !division || row.assignment.identity.divisionCode === division,
  );
  const sections: PrintSection[] = [];
  const title = {
    doors: "Room schedules",
    itineraries: "Team itineraries",
    judges: "Judge access cards",
    scoresheets: "Blank scoresheets",
    feedback: "Debater feedback",
    results: "Results",
  }[kind];
  if (kind === "doors") {
    const rows = drawRows(schedule, division);
    for (const room of schedule.rooms) {
      const debates = rows.filter((row) => row.room === room.name);
      if (!debates.length) continue;
      sections.push({
        title: room.name,
        subtitle: `Judges stay in this room. Teams move between rounds.`,
        columns: ["Round", "Division", "Government", "Opposition", "Motion"],
        rows: debates.map((row) => [
          String(row.round),
          row.division,
          `${row.governmentCode} · ${row.government}`,
          `${row.oppositionCode} · ${row.opposition}`,
          row.motion || "To be announced",
        ]),
        notes: [
          ...new Set(debates.map((row) => `Panel: ${row.judges}`)),
          "For impromptu rounds, confirm sides after the coin toss.",
        ],
      });
    }
  } else if (kind === "itineraries") {
    const rows = itineraryRows(schedule, division);
    for (const team of schedule.teams) {
      const itinerary = rows.filter(
        (row) => row.code === team.code && row.division === team.divisionCode,
      );
      if (!itinerary.length) continue;
      sections.push({
        title: `${team.code} · ${team.name}`,
        subtitle: `${team.school} · ${team.speakers.map((speaker) => speaker.name).join(" & ")}`,
        columns: ["Round", "Room", "Opponent", "Side"],
        rows: itinerary.map((row) => [
          String(row.round),
          row.room,
          `${row.opponentCode} · ${row.opponent}`,
          row.sidesDecided === "in-room" ? "Coin toss in the room" : row.side,
        ]),
        notes: ["Follow this itinerary to your next room. Judges remain in their allocated rooms."],
      });
    }
  } else if (kind === "judges") {
    for (const judge of graph.judges.filter((row) => row.status === "active")) {
      const assignments = records.filter((row) => row.assignment.identity.judgeId === judge.id);
      if (division && !assignments.length) continue;
      const link = joinLinkFor(joinTokenFor(judge));
      const room =
        graph.rooms.find((room) => room.id === judge.homeRoomId)?.name ?? "See the schedule";
      sections.push({
        title: judge.name,
        subtitle: room,
        columns: ["Tournament code", "Judge code"],
        rows: [[graph.tournament.joinCode ?? "Ask organiser", judge.code]],
        notes: [
          "Keep this card private. Scan to sign in.",
          "On iPhone, an installed home-screen app may ask you to enter these codes again.",
          "Open all three round cards while online before judging.",
          `Judge app: ${new URL("/j/", link).toString()}`,
        ],
        qr: await QRCode.toDataURL(link, { width: 240, margin: 1 }),
      });
    }
  } else if (kind === "scoresheets") {
    for (const { assignment } of records) {
      const { identity, display } = assignment;
      const speakers = [...display.speakers].sort((a, b) => {
        const order = ["pm", "lo", "gm", "om"];
        return order.indexOf(a.role) - order.indexOf(b.role);
      });
      sections.push({
        title: `${display.roomName} · Round ${identity.round} · ${display.judgeName}`,
        subtitle: `${display.government.code} ${display.government.name} / ${display.opposition.code} ${display.opposition.name}`,
        columns: [
          "Score / feedback",
          ...speakers.map((speaker) => `${speaker.name}\n${schedule.settings.roles[speaker.role]}`),
        ],
        rows: [
          ...schedule.settings.rubric.categories.map((category) => [
            `${category.label} / ${category.max}`,
            ...speakers.map(() => "________"),
          ]),
          [`Overall / ${schedule.settings.rubric.overallMax}`, ...speakers.map(() => "________")],
          ["What went well", ...speakers.map(() => "\n\n\n")],
          ["Even better if", ...speakers.map(() => "\n\n\n")],
        ],
        notes: [
          `Motion: ${display.motion || "To be announced"}`,
          "Sides as drawn [ ]  Sides reversed [ ]  Government roles swapped [ ]  Opposition roles swapped [ ]",
          "Overall is an independent judgement. Scores above 90 are very rare.",
          `No rebuttal attempted = ${schedule.settings.rubric.noRebuttalScore}.`,
          "Signed: __________________________",
          `Sheet reference: ${assignment.id}`,
        ],
      });
    }
  } else if (kind === "feedback") {
    const feedback = feedbackRows(records, division, schedule.settings.roles);
    const groups = new Map<string, typeof feedback>();
    for (const row of feedback) {
      const key = `${row.school}\0${row.debaterId}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const group of [...groups.values()].sort(
      (a, b) => a[0].school.localeCompare(b[0].school) || a[0].debater.localeCompare(b[0].debater),
    )) {
      const first = group[0];
      sections.push({
        title: first.debater,
        subtitle: `${first.school} · ${first.team} · ${first.division}`,
        columns: ["Round / judge", "Overall", "What went well", "Even better if"],
        rows: group.map((row) => [
          `R${row.round} · ${row.judge}\n${row.role}`,
          number(row.overall),
          row.www || "—",
          row.ebi || "—",
        ]),
        notes: [
          "Feedback is for the debater and their coach. Blank comments mean no written feedback was received.",
        ],
      });
    }
  } else {
    for (const divisionRow of graph.divisions.filter((row) => !division || row.code === division)) {
      const view = buildResultsView(graph, divisionRow.code);
      const status = view.published ? "Published" : "PROVISIONAL";
      sections.push({
        title: `${divisionRow.name} · teams`,
        subtitle: status,
        columns: ["Rank", "Code", "Team", "School", "Total"],
        rows: [...view.teams]
          .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
          .map((row) => [number(row.rank), row.code, row.name, row.school, number(row.total)]),
        notes: [
          view.policyText,
          ...(view.completeness.provisional
            ? ["Some sheets are missing. Results may change."]
            : []),
          "Equal totals share a rank; tied places are not broken automatically.",
        ],
      });
      sections.push({
        title: `${divisionRow.name} · debaters`,
        subtitle: status,
        columns: [
          "Rank",
          "Debater",
          "Team",
          ...schedule.settings.rounds.map((round) => `Round ${round.number}`),
          "Total",
        ],
        rows: [...view.debaters]
          .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
          .map((row) => [
            number(row.rank),
            row.name,
            row.teamName,
            ...row.rounds.map((round) => number(round.average)),
            number(row.total),
          ]),
        notes: [view.policyText],
      });
    }
  }
  return {
    tournament: graph.tournament.name,
    title,
    kind,
    practice: graph.tournament.kind !== "live",
    generatedAt: new Date().toISOString(),
    sections,
  };
}
