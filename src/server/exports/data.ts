import {
  drawCsv,
  feedbackCsv,
  fromDivisionResults,
  itineraryCsv,
  rawScoresCsv,
  resultsCsv,
  teamResultsCsv,
  type CsvSpec,
  type SheetRecord,
} from "@/domain/export";
import { errors } from "@/server/errors";
import { toSchedule, type TournamentGraph } from "@/server/services/graph";
import { buildResultsView } from "@/server/services/results";

export function exportRecords(graph: TournamentGraph): SheetRecord[] {
  return graph.assignments
    .filter((row) => row.live)
    .map((row) => {
      const sheet = graph.sheets.find((sheet) => sheet.assignmentId === row.id);
      return {
        assignment: {
          id: row.id,
          identity: row.identity,
          display: row.display,
          scheduleRevision: row.scheduleRevision,
        },
        sheet: sheet
          ? {
              payload: {
                scores: sheet.scores,
                sideFlipped: sheet.sideFlipped,
                roleSwaps: sheet.roleSwaps,
              },
              source: sheet.source,
              receivedAt: sheet.receivedAt.toISOString(),
            }
          : null,
      };
    });
}

export const CSV_FORMATS = [
  "draw",
  "itineraries",
  "debaters",
  "teams",
  "scores",
  "feedback",
] as const;
export type CsvFormat = (typeof CSV_FORMATS)[number];

export function csvExport(graph: TournamentGraph, format: CsvFormat, division?: string): CsvSpec {
  if (division && !graph.divisions.some((row) => row.code === division))
    throw errors.notFound("That division");
  const schedule = toSchedule(graph);
  if (format === "draw") return drawCsv(schedule, division);
  if (format === "itineraries") return itineraryCsv(schedule, division);
  const records = exportRecords(graph);
  if (format === "scores") return rawScoresCsv(records, division, schedule.settings.roles);
  if (format === "feedback") return feedbackCsv(records, division, schedule.settings.roles);
  const specs = graph.divisions
    .filter((row) => !division || row.code === division)
    .map((row) => {
      const view = buildResultsView(graph, row.code);
      const result = fromDivisionResults(view.results, row.code);
      const spec =
        format === "teams"
          ? teamResultsCsv(result, !view.published)
          : resultsCsv(result, graph.rounds.length, !view.published);
      return { ...spec, rows: spec.rows.map((values) => [row.name, ...values]) };
    });
  return {
    headers: ["Division", ...(specs[0]?.headers ?? [])],
    rows: specs.flatMap((spec) => spec.rows),
  };
}

/** ASCII attachment filename; all human-facing names remain in the document. */
export function exportFilename(slug: string, format: string, extension: string): string {
  return `${slug.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 70)}-${format}.${extension}`;
}
