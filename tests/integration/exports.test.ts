import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { layoutDebaterRows, WORKBOOK_COLUMNS } from "@/domain/export";
import { publicPathFor } from "@/domain/public-page";
import { getDb, tournaments } from "@/server/db";
import { CSV_FORMATS, csvExport } from "@/server/exports/data";
import { buildPrintPack, PRINT_KINDS } from "@/server/exports/print-pack";
import { printPackPdf } from "@/server/exports/pdf";
import { buildWorkbook } from "@/server/exports/workbook";
import { publicTournament } from "@/server/public-tournament";
import { createDemoTournament } from "@/server/services/demo";
import { confirmFinalists, getFinalistConfirmation } from "@/server/services/finalists";
import { finalizeDivision, reopenDivision } from "@/server/services/finalize";
import { loadGraph, toSchedule, type TournamentGraph } from "@/server/services/graph";
import { addOverride } from "@/server/services/overrides";
import { buildResultsView } from "@/server/services/results";
import { testContext } from "./helpers";

let graph: TournamentGraph;
beforeAll(async () => {
  const db = await getDb();
  const demo = await createDemoTournament(testContext(db), {
    kind: "demo",
    stage: "complete",
    seed: "export-proof",
  });
  graph = await loadGraph(db, demo.tournamentId);
});

describe("reviewable tournament exports", () => {
  it("projects every CSV without access credentials and refuses unknown divisions", () => {
    for (const format of CSV_FORMATS) {
      const spec = csvExport(graph, format);
      expect(spec.rows.length).toBeGreaterThan(0);
      expect(spec.rows.every((row) => row.length === spec.headers.length)).toBe(true);
      const encoded = JSON.stringify(spec);
      for (const judge of graph.judges) {
        expect(encoded).not.toContain(judge.joinTokenHash);
        expect(encoded).not.toContain(judge.code);
      }
    }
    expect(() => csvExport(graph, "draw", "unknown")).toThrow();
  });

  it("reopens the director workbook with live formulas and exact cached scores/ranks", async () => {
    const bytes = await buildWorkbook(graph, "Open");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const master = workbook.getWorksheet("Master Sheet")!;
    expect(master.getRow(4).values).toEqual([
      undefined,
      ...WORKBOOK_COLUMNS.map((column) => column.label),
    ]);
    const view = buildResultsView(graph, "Open");
    const layout = layoutDebaterRows(
      toSchedule(graph).teams.filter((team) => team.divisionCode === "Open"),
    );
    for (const entry of layout) {
      const debater = view.debaters.find((row) => row.id === entry.speakerId)!;
      expect(master.getCell(`E${entry.row}`).value).toBe(debater.name);
      expect(master.getCell(`BA${entry.row}`).result).toBe(debater.total);
      expect(master.getCell(`BC${entry.row}`).result).toBe(debater.rank);
      expect(master.getCell(`P${entry.row}`).formula).toContain("AVERAGEIFS");
      expect(master.getCell(`AX${entry.row}`).formula).toContain("STDEV.S");
      expect(master.getCell(`BC${entry.row}`).formula).toContain("RANK.EQ");
    }
    expect(workbook.getWorksheet("Sheet1")!.rowCount).toBe(25);
    expect(workbook.getWorksheet("Report (team)")!.rowCount).toBe(16);
  });

  it("builds all print packs with fixed-room schedules, private cards, and demo marks", async () => {
    const counts = {
      doors: 10,
      itineraries: 20,
      judges: 30,
      scoresheets: 90,
      feedback: 40,
      results: 4,
    };
    for (const kind of PRINT_KINDS) {
      const pack = await buildPrintPack(graph, kind);
      expect(pack.practice).toBe(true);
      expect(pack.sections).toHaveLength(counts[kind]);
      if (kind === "doors")
        expect(pack.sections.every((section) => section.rows.length === 3)).toBe(true);
      if (kind === "judges")
        expect(
          pack.sections.every((section) => section.qr?.startsWith("data:image/png;base64,")),
        ).toBe(true);
    }
    const blank = await buildPrintPack(graph, "scoresheets");
    const pdf = await printPackPdf({ ...blank, sections: blank.sections.slice(0, 1) });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(2000);
  });

  it("requires explicit public opt-in and shows only published division results", async () => {
    const db = await getDb(),
      ctx = testContext(db),
      id = graph.tournament.id;
    const key = decodeURIComponent(publicPathFor(graph.tournament).slice(3));
    await expect(publicTournament(db, key)).rejects.toMatchObject({ code: "not_found" });
    await db
      .update(tournaments)
      .set({
        settings: {
          ...graph.tournament.settings,
          publicPage: { enabled: true, showProvisional: false },
        },
      })
      .where(eq(tournaments.id, id));
    expect((await publicTournament(db, key)).results).toHaveLength(0);
    await finalizeDivision(ctx, {
      tournamentId: id,
      divisionCode: "Open",
      acknowledgePolicy: true,
    });
    const data = await publicTournament(db, key);
    expect(data.results).toHaveLength(1);
    const text = JSON.stringify(data);
    expect(text).not.toContain("assignmentId");
    expect(text).not.toContain("www");
    for (const judge of graph.judges) {
      expect(text).not.toContain(judge.code);
      expect(text).not.toContain(judge.name);
    }
    await reopenDivision(ctx, {
      tournamentId: id,
      divisionCode: "Open",
      reason: "Test publication visibility",
    });
    expect((await publicTournament(db, key)).results).toHaveLength(0);
  });

  it("audits finalist choice and invalidates it when a scoring decision changes", async () => {
    const db = await getDb(),
      ctx = testContext(db);
    graph = await loadGraph(db, graph.tournament.id);
    const view = buildResultsView(graph, "Open");
    const top = [...view.teams]
      .filter((team) => team.rank !== null)
      .sort((a, b) => a.rank! - b.rank!);
    await expect(
      confirmFinalists(ctx, {
        tournamentId: graph.tournament.id,
        divisionCode: "Open",
        teamIds: top.slice(-2).map((team) => team.id),
        reason: "Invalid lower teams",
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await confirmFinalists(ctx, {
      tournamentId: graph.tournament.id,
      divisionCode: "Open",
      teamIds: top.slice(0, 2).map((team) => team.id),
      reason: "Highest ranked teams confirmed",
    });
    expect((await getFinalistConfirmation(db, view))?.teamIds).toEqual(
      top.slice(0, 2).map((team) => team.id),
    );
    const target = view.debaters[0],
      source = target.rounds[0].scores.find((score) => score.kept)!;
    await addOverride(ctx, {
      tournamentId: graph.tournament.id,
      divisionCode: "Open",
      kind: "force_exclude",
      speakerId: target.id,
      assignmentId: source.assignmentId,
      round: 1,
      reason: "Correct a test score decision",
    });
    const updated = buildResultsView(await loadGraph(db, graph.tournament.id), "Open");
    expect(await getFinalistConfirmation(db, updated)).toBeNull();
  });
});

function closeOrNull(actual: number | string | null, expected: number | null) {
  if (expected === null) expect(actual).toBeNull();
  else expect(actual).toBeCloseTo(expected);
}

/** Small independent reader for the exported aggregate formulas. It never uses cached results. */
function calculate(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  address: string,
): number | string | null {
  const sheet = workbook.getWorksheet(sheetName)!;
  const value = sheet.getCell(address).value;
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value !== "object" || !("formula" in value))
    throw new Error("Unsupported workbook cell");
  const split = (text: string) => {
    const parts: string[] = [];
    let depth = 0,
      quote = "",
      start = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quote) {
        if (char === quote) {
          if (text[index + 1] === quote) index++;
          else quote = "";
        }
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
      else if (char === "," && depth === 0) {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(text.slice(start));
    return parts;
  };
  const evaluate = (expression: string): number | string | null | (number | string | null)[] => {
    if (expression === '""') return null;
    if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(expression)) return Number(expression);
    const comparison = /^(.+)=(\d+)$/.exec(expression);
    if (comparison) return Number(evaluate(comparison[1]) === Number(comparison[2]));
    const subtraction = /^(\d+)-(INT\(.*\))$/.exec(expression);
    if (subtraction) return Number(subtraction[1]) - Number(evaluate(subtraction[2]));
    const call = /^([A-Z][A-Z0-9.]+)\((.*)\)$/.exec(expression);
    if (call) {
      const args = split(call[2]);
      if (call[1] === "IF") return evaluate(args[evaluate(args[0]) ? 1 : 2]);
      const values = args.flatMap((arg) => evaluate(arg));
      const numbers = values.filter((item): item is number => typeof item === "number");
      switch (call[1]) {
        case "COUNT":
          return numbers.length;
        case "SUM":
          return numbers.reduce((sum, n) => sum + n, 0);
        case "AVERAGE":
          return numbers.length ? numbers.reduce((sum, n) => sum + n, 0) / numbers.length : null;
        case "ISNUMBER":
          return Number(typeof values[0] === "number");
        case "ABS":
          return Math.abs(Number(values[0]));
        case "LOG10":
          return Math.log10(Number(values[0]));
        case "INT":
          return Math.floor(Number(values[0]));
        case "ROUND":
          return Number(Number(values[0]).toFixed(Number(values[1])));
        case "RANK.EQ":
          return typeof values[0] === "number"
            ? 1 +
                (Array.isArray(evaluate(args[1]))
                  ? (evaluate(args[1]) as (number | null)[])
                  : [evaluate(args[1])]
                ).filter((n) => typeof n === "number" && n > Number(values[0])).length
            : null;
        default:
          throw new Error(`Unsupported exported function ${call[1]}`);
      }
    }
    const reference = /^(?:'((?:[^']|'')+)'!)?(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?$/.exec(
      expression,
    );
    if (!reference) throw new Error(`Unsupported exported expression ${expression}`);
    const target = reference[1]?.replaceAll("''", "'") ?? sheetName;
    const first = reference[2].replaceAll("$", "");
    if (!reference[3]) return calculate(workbook, target, first);
    const last = reference[3].replaceAll("$", "");
    const column = /^[A-Z]+/.exec(first)![0];
    const lastColumn = /^[A-Z]+/.exec(last)![0];
    if (column !== lastColumn) throw new Error("Expected one-column aggregate range");
    return Array.from(
      { length: Number(last.slice(column.length)) - Number(first.slice(column.length)) + 1 },
      (_, index) =>
        calculate(workbook, target, `${column}${Number(first.slice(column.length)) + index}`),
    );
  };
  const result = evaluate(value.formula!);
  if (Array.isArray(result)) throw new Error("Expected scalar cell");
  return result;
}

it("recalculates Excel ranks without splitting fractional-sum ties or merging distinct scores", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Precision");
  for (const [index, marks] of [
    [80, 80 + 1 / 3, 80 + 1 / 3],
    [80 + 1 / 3, 80 + 1 / 3, 80],
    [80, 80 + 1 / 3, 80 + 1 / 3 + 0.000001],
  ].entries()) {
    const row = index + 1;
    sheet.getCell(`A${row}`).value = marks[0];
    sheet.getCell(`B${row}`).value = marks[1];
    sheet.getCell(`C${row}`).value = marks[2];
    sheet.getCell(`D${row}`).value = { formula: `SUM(A${row},B${row},C${row})` };
    sheet.getCell(`E${row}`).value = { formula: `ROUND(D${row},14-INT(LOG10(ABS(D${row}))))` };
    sheet.getCell(`F${row}`).value = { formula: `RANK.EQ(E${row},E1:E3,0)` };
  }
  expect(calculate(workbook, sheet.name, "D1")).not.toBe(calculate(workbook, sheet.name, "D2"));
  expect([1, 2, 3].map((row) => calculate(workbook, sheet.name, `F${row}`))).toEqual([2, 2, 1]);
});

it("the exported custom workbook preserves ties when live raw marks produce differently ordered sums", async () => {
  const data = structuredClone(graph);
  data.scoreOverrides = [];
  data.tournament.scoringPolicy = {
    ...(data.tournament.scoringPolicy as Record<string, unknown>),
    bounds: "inclusive",
  };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildWorkbook(data, "Open")) as unknown as ExcelJS.Buffer);
  const master = workbook.getWorksheet("Master Sheet")!;
  const decisions = workbook.getWorksheet("Kept marks")!;
  const rows = layoutDebaterRows(
    toSchedule(data).teams.filter((team) => team.divisionCode === "Open"),
  )
    .map((entry) => entry.row)
    .filter((row) =>
      ["P", "AD", "AR"].every(
        (column) =>
          [...(master.getCell(`${column}${row}`).formula ?? "").matchAll(/!E(\d+)/g)].length === 3,
      ),
    );
  expect(rows.length).toBeGreaterThanOrEqual(3);
  for (const [index, pattern] of [
    [
      [80, 80, 80],
      [80, 80, 81],
      [80, 80, 81],
    ],
    [
      [80, 80, 81],
      [80, 80, 81],
      [80, 80, 80],
    ],
    [
      [80, 80, 80],
      [80, 80, 81],
      [80, 80, 82],
    ],
  ].entries()) {
    for (const [round, column] of ["P", "AD", "AR"].entries()) {
      const kept = [...master.getCell(`${column}${rows[index]}`).formula.matchAll(/!E(\d+)/g)];
      for (const [slot, reference] of kept.entries()) {
        const rawAddress = decisions.getCell(`E${reference[1]}`).formula.split("!")[1];
        master.getCell(rawAddress).value = pattern[round][slot];
      }
    }
  }
  expect(calculate(workbook, master.name, `BA${rows[0]}`)).not.toBe(
    calculate(workbook, master.name, `BA${rows[1]}`),
  );
  const first = calculate(workbook, master.name, `BC${rows[0]}`);
  expect(calculate(workbook, master.name, `BC${rows[1]}`)).toBe(first);
  expect(Number(calculate(workbook, master.name, `BC${rows[2]}`))).toBeLessThan(Number(first));
});

it.each(["export-overrides-proof", "export-overrides-proof-2", "export-overrides-proof-3"])(
  "recalculates exclusions and single-speaker decisions consistently in every report and round (%s)",
  async (seed) => {
    const db = await getDb(),
      ctx = testContext(db);
    const demo = await createDemoTournament(ctx, {
      kind: "demo",
      stage: "complete",
      seed,
    });
    let data = await loadGraph(db, demo.tournamentId);
    const initial = buildResultsView(data, "Open");
    const excluded = initial.debaters[0];
    await addOverride(ctx, {
      tournamentId: demo.tournamentId,
      divisionCode: "Open",
      kind: "exclude_debater",
      speakerId: excluded.id,
      reason: "Fictional withdrawn debater",
    });
    for (const single of [false, true]) {
      if (single)
        await addOverride(ctx, {
          tournamentId: demo.tournamentId,
          divisionCode: "Open",
          kind: "rank_single_speaker_team",
          teamId: excluded.teamId,
          reason: "Fictional one-person team permitted",
        });
      data = await loadGraph(db, demo.tournamentId);
      const view = buildResultsView(data, "Open");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await buildWorkbook(data, "Open")) as unknown as ExcelJS.Buffer);
      const layout = layoutDebaterRows(
        toSchedule(data).teams.filter((team) => team.divisionCode === "Open"),
      );
      const target = layout.find((entry) => entry.speakerId === excluded.id)!;
      const mate = layout.find(
        (entry) => entry.team.id === excluded.teamId && entry.speakerId !== excluded.id,
      )!;
      const remaining = view.debaters.find((row) => row.id === mate.speakerId)!;
      expect(calculate(workbook, "Master Sheet", `BA${target.row}`)).toBeNull();
      expect(calculate(workbook, "Master Sheet", `BC${target.row}`)).toBeNull();
      const team = view.teams.find((team) => team.id === excluded.teamId)!;
      expect(team.total).toBe(single ? remaining.total : null);
      for (const entry of layout) {
        const debater = view.debaters.find((row) => row.id === entry.speakerId)!;
        closeOrNull(calculate(workbook, "Master Sheet", `BA${entry.row}`), debater.total);
        expect(calculate(workbook, "Master Sheet", `BC${entry.row}`)).toBe(debater.rank);
        const expected = view.teams.find((team) => team.id === entry.team.id)!;
        closeOrNull(calculate(workbook, "Master Sheet", `BB${entry.row}`), expected.total);
        expect(calculate(workbook, "Master Sheet", `BD${entry.row}`)).toBe(expected.rank);
      }
      for (const [round, average, teamScore, individualRank] of [
        [1, "P", "Q", "R"],
        [2, "AD", "AE", "AF"],
        [3, "AR", "AS", "AT"],
      ] as const) {
        expect(calculate(workbook, "Master Sheet", `${individualRank}${target.row}`)).toBeNull();
        expect(calculate(workbook, "Master Sheet", `${teamScore}${mate.row}`)).toBe(
          single ? remaining.rounds[round - 1].average : null,
        );
        const expectedRank =
          1 +
          view.debaters.filter(
            (row) =>
              row.id !== excluded.id &&
              Number(row.rounds[round - 1].average) > Number(remaining.rounds[round - 1].average),
          ).length;
        expect(calculate(workbook, "Master Sheet", `${individualRank}${mate.row}`)).toBe(
          expectedRank,
        );
        expect(calculate(workbook, "Master Sheet", `${average}${mate.row}`)).toBeCloseTo(
          remaining.rounds[round - 1].average!,
        );
      }
    }
  },
);

it("custom pooled and per-round population policies agree after formula recalculation", async () => {
  for (const scope of ["perRound", "pooled"]) {
    const data = structuredClone(graph);
    data.tournament.scoringPolicy = {
      ...(data.tournament.scoringPolicy as Record<string, unknown>),
      scope,
      sd: "population",
      bounds: "inclusive",
      sdMultiplier: 1,
    };
    const view = buildResultsView(data, "Open");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildWorkbook(data, "Open")) as unknown as ExcelJS.Buffer);
    const layout = layoutDebaterRows(
      toSchedule(data).teams.filter((team) => team.divisionCode === "Open"),
    );
    for (const entry of layout) {
      const debater = view.debaters.find((row) => row.id === entry.speakerId)!;
      for (const [column, expected] of [
        ["AW", debater.range.average],
        ["AX", debater.range.spread],
        ["AY", debater.range.upper],
        ["AZ", debater.range.lower],
      ] as const)
        closeOrNull(calculate(workbook, "Master Sheet", `${column}${entry.row}`), expected);
      for (const [index, column] of ["P", "AD", "AR"].entries())
        closeOrNull(
          calculate(workbook, "Master Sheet", `${column}${entry.row}`),
          debater.rounds[index].average,
        );
      closeOrNull(calculate(workbook, "Master Sheet", `BA${entry.row}`), debater.total);
      expect(calculate(workbook, "Master Sheet", `BC${entry.row}`)).toBe(debater.rank);
    }
  }
});
