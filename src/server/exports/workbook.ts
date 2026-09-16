import ExcelJS from "exceljs";
import { WORKBOOK_COLUMNS, columnLetter, layoutDebaterRows, workbookColumn } from "@/domain/export";
import { WORKBOOK_POLICY, rankEq } from "@/domain/scoring";
import { canonicalJson } from "@/domain/schedule/canonical-json";
import { errors } from "@/server/errors";
import { toSchedule, type TournamentGraph } from "@/server/services/graph";
import { buildResultsView } from "@/server/services/results";

const quote = (name: string) => `'${name.replace(/'/g, "''")}'`;
const cell = (key: string, row: number) => `${workbookColumn(key).letter}${row}`;
// Explicitly match the engine's 15-significant-digit rank keys. Excel's
// RANK.EQ can distinguish binary rounding noise in sums of round averages.
const rankKeyFormula = (reference: string) =>
  `IF(ISNUMBER(${reference}),ROUND(${reference},IF(${reference}=0,14,14-INT(LOG10(ABS(${reference}))))),"")`;
const formula = (
  sheet: ExcelJS.Worksheet,
  address: string,
  expression: string,
  value: number | null,
) => {
  sheet.getCell(address).value = { formula: expression, result: value ?? "" };
};

/** Director's three-round column map, with calculated values usable before Excel recalculates. */
export async function buildWorkbook(
  graph: TournamentGraph,
  divisionCode?: string,
): Promise<Buffer> {
  if (graph.rounds.length !== 3)
    throw errors.validation(
      "The director's workbook has three rounds. Use the CSV exports for this tournament's round format.",
    );
  const divisions = graph.divisions.filter((row) => !divisionCode || row.code === divisionCode);
  if (!divisions.length) throw errors.notFound("That division");
  const schedule = toSchedule(graph);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Dais";
  workbook.calcProperties.fullCalcOnLoad = true;
  const about = workbook.addWorksheet("Read me");
  about.columns = [{ width: 28 }, { width: 100 }];
  about.addRows([
    ["Tournament", graph.tournament.name],
    [
      "Status",
      graph.tournament.kind === "live"
        ? "Tournament export"
        : "DEMO / PRACTICE — fictional or practice data",
    ],
    ["Scoring", "Overall scores are independent of the category sum. Ranks preserve ties."],
    [
      "Editing",
      "Default workbook-policy formulas recalculate when raw marks change. With custom policy or overrides, kept decisions are a snapshot: re-export from Dais after changing those decisions.",
    ],
    ["Blank cells", "Missing or unrankable results stay blank. Zero is a real score."],
    ["Privacy", "This workbook contains participant information. Share with the tournament team."],
  ]);
  const importSheet = workbook.addWorksheet("Sheet1");
  importSheet.addRow(["School Name", "Student Name", "Team Name"]);
  for (const team of schedule.teams.filter((team) =>
    divisions.some((division) => division.code === team.divisionCode),
  )) {
    for (const speaker of team.speakers) importSheet.addRow([team.school, speaker.name, team.name]);
  }
  importSheet.columns.forEach((col) => {
    col.width = 28;
  });
  for (const division of divisions) {
    const suffix = divisions.length === 1 ? "" : ` ${division.code}`;
    const master = workbook.addWorksheet(`Master Sheet${suffix}`.slice(0, 31));
    const teamSheet = workbook.addWorksheet(`Report (team)${suffix}`.slice(0, 31));
    const debaterSheet = workbook.addWorksheet(`Report (debaters)${suffix}`.slice(0, 31));
    const decisions = workbook.addWorksheet(`Kept marks${suffix}`.slice(0, 31));
    decisions.addRow(["Debater", "Round", "Judge", "Decision", "Kept score", "Source cell"]);
    const view = buildResultsView(graph, division.code);
    const layout = layoutDebaterRows(
      schedule.teams.filter(
        (team) => team.divisionCode === division.code && team.status === "active",
      ),
    );
    const last = Math.max(44, layout.length + 4);
    const byId = new Map(view.debaters.map((debater) => [debater.id, debater]));
    const allTeams = [...view.teams].sort(
      (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.code.localeCompare(b.code),
    );
    const teamReportRows = new Map(allTeams.map((team, index) => [team.id, index + 5]));
    const defaultFormula =
      canonicalJson(view.policy) === canonicalJson(WORKBOOK_POLICY) &&
      graph.scoreOverrides.every((row) => row.revokedAt || row.divisionCode !== division.code);
    master.getCell("A1").value = `${graph.tournament.name} — ${division.name}`;
    master.getCell("A2").value = view.published
      ? "Published results"
      : "PROVISIONAL — check missing sheets and decisions";
    master.getCell("A3").value = view.policyText;
    master.mergeCells("A1:BD1");
    master.mergeCells("A2:BD2");
    master.mergeCells("A3:BD3");
    for (const col of WORKBOOK_COLUMNS) {
      master.getCell(4, col.index).value = col.label;
      master.getColumn(col.index).width = col.kind === "text" ? 24 : 13;
    }
    master.views = [{ state: "frozen", xSplit: 5, ySplit: 4 }];
    master.autoFilter = `A4:BD${last}`;
    master.pageSetup = {
      orientation: "landscape",
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:4",
    };
    for (const report of [teamSheet, debaterSheet]) {
      report.getCell("A1").value = `${graph.tournament.name} — ${division.name}`;
      report.getCell("A2").value = view.published ? "Published results" : "Provisional results";
      report.columns = Array.from({ length: 8 }, (_, index) => ({ width: index === 0 ? 10 : 26 }));
      report.views = [{ state: "frozen", ySplit: 4 }];
    }
    teamSheet.getRow(4).values = [
      "Rank",
      "Code",
      "School",
      "Team",
      "Total",
      "Round 1",
      "Round 2",
      "Round 3",
    ];
    debaterSheet.getRow(4).values = [
      "Rank",
      "Debater",
      "School",
      "Team",
      "Total",
      "Round 1",
      "Round 2",
      "Round 3",
    ];
    const excludedIds = new Set(
      view.debaters
        .filter((debater) =>
          debater.overrides.some((override) => override.kind === "exclude_debater"),
        )
        .map((debater) => debater.id),
    );
    const membersFor = (teamId: string) =>
      view.debaters.filter((debater) => debater.teamId === teamId && !excludedIds.has(debater.id));
    const requiredFor = (teamId: string) =>
      graph.scoreOverrides.some(
        (override) =>
          !override.revokedAt &&
          override.divisionCode === division.code &&
          override.teamId === teamId &&
          override.kind === "rank_single_speaker_team",
      )
        ? Math.min(2, membersFor(teamId).length)
        : 2;
    const roundTeamValue = (teamId: string, round: number) => {
      const members = membersFor(teamId);
      const required = requiredFor(teamId);
      if (
        !required ||
        members.length !== required ||
        members.some((member) => member.rounds[round - 1]?.average == null)
      )
        return null;
      return members.reduce((sum, member) => sum + member.rounds[round - 1].average!, 0);
    };
    // A separate rank pool preserves raw round averages while excluding withdrawn debaters.
    if (!defaultFormula)
      for (const [index, entry] of layout.entries())
        for (let round = 1; round <= 3; round++) {
          const address = `${columnLetter(round + 6)}${index + 2}`;
          decisions.getCell(`${columnLetter(round + 6)}1`).value = `Round ${round} ranked averages`;
          const value = excludedIds.has(entry.speakerId)
            ? null
            : byId.get(entry.speakerId)!.rounds[round - 1].average;
          formula(
            decisions,
            address,
            excludedIds.has(entry.speakerId)
              ? '""'
              : rankKeyFormula(`${quote(master.name)}!${cell(`r${round}-average`, entry.row)}`),
            value,
          );
        }
    if (!defaultFormula) {
      decisions.getCell("J1").value = "Debater total rank keys";
      decisions.getCell("K1").value = "Team total rank keys";
      for (const [index, entry] of layout.entries())
        formula(
          decisions,
          `J${index + 2}`,
          rankKeyFormula(`${quote(master.name)}!BA${entry.row}`),
          byId.get(entry.speakerId)!.total,
        );
      for (const [index, team] of allTeams.entries()) {
        const reportRow = teamReportRows.get(team.id)!;
        formula(
          decisions,
          `K${index + 2}`,
          rankKeyFormula(`${quote(teamSheet.name)}!E${reportRow}`),
          team.total,
        );
        for (let round = 1; round <= 3; round++) {
          const column = columnLetter(round + 11);
          decisions.getCell(`${column}1`).value = `Round ${round} team rank keys`;
          formula(
            decisions,
            `${column}${index + 2}`,
            rankKeyFormula(`${quote(teamSheet.name)}!${columnLetter(round + 5)}${reportRow}`),
            roundTeamValue(team.id, round),
          );
        }
      }
    }
    for (const entry of layout) {
      const { row, team, speakerId } = entry;
      const debater = byId.get(speakerId)!;
      master.getCell(`A${row}`).value = team.school;
      master.getCell(`B${row}`).value = entry.pairLabel;
      master.getCell(`C${row}`).value = team.name;
      master.getCell(`E${row}`).value = entry.debater;
      const scoreRefs: string[] = [];
      for (let round = 1; round <= 3; round++) {
        const roundView = debater.rounds.find((item) => item.round === round)!;
        const assignments = graph.assignments
          .filter(
            (item) =>
              item.live &&
              item.identity.round === round &&
              item.identity.speakers.some((speaker) => speaker.id === speakerId),
          )
          .sort((a, b) => {
            const seatA =
              graph.debateJudges.find(
                (seat) => seat.debateId === a.debateId && seat.judgeId === a.judgeId,
              )?.seat ?? 0;
            const seatB =
              graph.debateJudges.find(
                (seat) => seat.debateId === b.debateId && seat.judgeId === b.judgeId,
              )?.seat ?? 0;
            return seatA - seatB;
          });
        const keptRefs: string[] = [];
        for (let slot = 1; slot <= 5; slot++) {
          const assignment = assignments[slot - 1];
          const address = cell(`r${round}-j${slot}-score`, row);
          scoreRefs.push(address);
          if (!assignment) continue;
          const source = roundView.scores.find((item) => item.assignmentId === assignment.id);
          // A non-secret panel label. Judge login codes never enter score exports.
          master.getCell(cell(`r${round}-j${slot}-code`, row)).value =
            `J${graph.judges.findIndex((judge) => judge.id === assignment.judgeId) + 1}`;
          master.getCell(address).value = source?.value ?? null;
          if (source && !source.kept)
            master.getCell(address).fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFFFE8CC" },
            };
          if (source?.kept) {
            const decisionRow = decisions.addRow([
              entry.debater,
              round,
              source.judgeName,
              source.label,
              null,
              `${master.name}!${address}`,
            ]);
            formula(
              decisions,
              `E${decisionRow.number}`,
              `${quote(master.name)}!${address}`,
              source.value,
            );
            keptRefs.push(`${quote(decisions.name)}!E${decisionRow.number}`);
          }
        }
        const low = `$AZ${row}`,
          high = `$AY${row}`;
        const start = cell(`r${round}-j1-score`, row),
          end = cell(`r${round}-j5-score`, row);
        const expression = defaultFormula
          ? `IFERROR(AVERAGEIFS(${start}:${end},${start}:${end},">"&${low},${start}:${end},"<"&${high}),"")`
          : keptRefs.length
            ? `AVERAGE(${keptRefs.join(",")})`
            : '""';
        formula(master, cell(`r${round}-average`, row), expression, roundView.average);
        const mates = layout.filter(
          (candidate) => candidate.team.id === team.id && !excludedIds.has(candidate.speakerId),
        );
        const averages = mates.map((mate) => cell(`r${round}-average`, mate.row));
        const teamValue = roundTeamValue(team.id, round);
        formula(
          master,
          cell(`r${round}-team-score`, row),
          averages.length
            ? `IF(COUNT(${averages.join(",")})=${requiredFor(team.id) || 999},SUM(${averages.join(",")}),"")`
            : '""',
          teamValue,
        );
        const averageCol = workbookColumn(`r${round}-average`).letter;
        const ranks = rankEq(
          view.debaters.map((speaker) =>
            excludedIds.has(speaker.id) ? null : (speaker.rounds[round - 1]?.average ?? null),
          ),
        );
        formula(
          master,
          cell(`r${round}-individual-rank`, row),
          excludedIds.has(speakerId)
            ? '""'
            : `IF(ISNUMBER(${averageCol}${row}),RANK.EQ(${defaultFormula ? `${averageCol}${row}` : `${quote(decisions.name)}!${columnLetter(round + 6)}${layout.indexOf(entry) + 2}`},${defaultFormula ? `${averageCol}$5:${averageCol}$${last}` : `${quote(decisions.name)}!$${columnLetter(round + 6)}$2:$${columnLetter(round + 6)}$${layout.length + 1}`},0),"")`,
          ranks[view.debaters.findIndex((speaker) => speaker.id === speakerId)],
        );
        const teamCol = workbookColumn(`r${round}-team-score`).letter;
        const reportCol = columnLetter(round + 5);
        const teamValues = allTeams.map((item) => roundTeamValue(item.id, round));
        formula(
          master,
          cell(`r${round}-team-rank`, row),
          defaultFormula
            ? `IF(ISNUMBER(${teamCol}${row}),RANK.EQ(${teamCol}${row},${quote(teamSheet.name)}!${reportCol}$5:${reportCol}$${allTeams.length + 4},0),"")`
            : `IF(ISNUMBER(${teamCol}${row}),RANK.EQ(${quote(decisions.name)}!${columnLetter(round + 11)}${allTeams.findIndex((item) => item.id === team.id) + 2},${quote(decisions.name)}!${columnLetter(round + 11)}$2:${columnLetter(round + 11)}$${allTeams.length + 1},0),"")`,
          rankEq(teamValues)[allTeams.findIndex((item) => item.id === team.id)],
        );
      }
      formula(
        master,
        `AW${row}`,
        defaultFormula
          ? `IFERROR(AVERAGE(${scoreRefs.join(",")}),"")`
          : String(debater.range.average ?? '""'),
        debater.range.average,
      );
      formula(
        master,
        `AX${row}`,
        defaultFormula
          ? `IFERROR(STDEV.S(${scoreRefs.join(",")}),"")`
          : String(debater.range.spread ?? '""'),
        debater.range.spread,
      );
      formula(
        master,
        `AY${row}`,
        defaultFormula
          ? `IF(ISNUMBER(AX${row}),AW${row}+2*AX${row},"")`
          : String(debater.range.upper ?? '""'),
        debater.range.upper,
      );
      formula(
        master,
        `AZ${row}`,
        defaultFormula
          ? `IF(ISNUMBER(AX${row}),AW${row}-2*AX${row},"")`
          : String(debater.range.lower ?? '""'),
        debater.range.lower,
      );
      formula(
        master,
        `BA${row}`,
        debater.overrides.some((override) => override.kind === "exclude_debater")
          ? '""'
          : `IF(COUNT(P${row},AD${row},AR${row})=3,SUM(P${row},AD${row},AR${row}),"")`,
        debater.total,
      );
      const memberRows = layout
        .filter(
          (candidate) =>
            candidate.team.id === team.id &&
            !byId
              .get(candidate.speakerId)
              ?.overrides.some((override) => override.kind === "exclude_debater"),
        )
        .map((mate) => `BA${mate.row}`);
      const teamResult = view.teams.find((item) => item.id === team.id)!;
      const requiredMembers = graph.scoreOverrides.some(
        (override) =>
          !override.revokedAt &&
          override.teamId === team.id &&
          override.kind === "rank_single_speaker_team",
      )
        ? Math.min(2, memberRows.length)
        : 2;
      formula(
        master,
        `BB${row}`,
        memberRows.length
          ? `IF(COUNT(${memberRows.join(",")})=${requiredMembers},SUM(${memberRows.join(",")}),"")`
          : '""',
        teamResult.total,
      );
      formula(
        master,
        `BC${row}`,
        defaultFormula
          ? `IF(ISNUMBER(BA${row}),RANK.EQ(BA${row},BA$5:BA$${last},0),"")`
          : `IF(ISNUMBER(BA${row}),RANK.EQ(${quote(decisions.name)}!J${layout.indexOf(entry) + 2},${quote(decisions.name)}!J$2:J$${layout.length + 1},0),"")`,
        debater.rank,
      );
      formula(
        master,
        `BD${row}`,
        defaultFormula
          ? `IF(ISNUMBER(BB${row}),RANK.EQ(BB${row},${quote(teamSheet.name)}!E$5:E$${allTeams.length + 4},0),"")`
          : `IF(ISNUMBER(BB${row}),RANK.EQ(${quote(decisions.name)}!K${allTeams.findIndex((item) => item.id === team.id) + 2},${quote(decisions.name)}!K$2:K$${allTeams.length + 1},0),"")`,
        teamResult.rank,
      );
    }
    for (const team of allTeams) {
      const row = teamReportRows.get(team.id)!;
      const source = layout.find((entry) => entry.team.id === team.id);
      teamSheet.getRow(row).values = [null, team.code, team.school, team.name];
      if (!source) continue;
      formula(teamSheet, `A${row}`, `${quote(master.name)}!BD${source.row}`, team.rank);
      formula(teamSheet, `E${row}`, `${quote(master.name)}!BB${source.row}`, team.total);
      for (let round = 1; round <= 3; round++) {
        const total = roundTeamValue(team.id, round);
        formula(
          teamSheet,
          `${columnLetter(round + 5)}${row}`,
          `${quote(master.name)}!${cell(`r${round}-team-score`, source.row)}`,
          total,
        );
      }
    }
    [...view.debaters]
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.localeCompare(b.name))
      .forEach((debater, index) => {
        const row = index + 5,
          source = layout.find((entry) => entry.speakerId === debater.id)!;
        debaterSheet.getRow(row).values = [null, debater.name, debater.school, debater.teamName];
        formula(debaterSheet, `A${row}`, `${quote(master.name)}!BC${source.row}`, debater.rank);
        formula(debaterSheet, `E${row}`, `${quote(master.name)}!BA${source.row}`, debater.total);
        for (let round = 1; round <= 3; round++)
          formula(
            debaterSheet,
            `${columnLetter(round + 5)}${row}`,
            `${quote(master.name)}!${cell(`r${round}-average`, source.row)}`,
            debater.rounds[round - 1]?.average ?? null,
          );
      });
    for (const sheet of [master, teamSheet, debaterSheet]) {
      sheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E8C" } };
      sheet.eachRow((row, number) => {
        if (number >= 5)
          row.eachCell((value) => {
            if (value.type === ExcelJS.ValueType.Formula || value.type === ExcelJS.ValueType.Number)
              value.numFmt = "0.00;-0.00;0";
          });
      });
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
