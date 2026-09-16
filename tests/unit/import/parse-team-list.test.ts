import { describe, expect, it } from "vitest";
import {
  codePrefix,
  CodeIssuer,
  detectDelimiter,
  matchDivision,
  parseTeamList,
  splitRow,
  tidy,
} from "@/domain/import/parse-team-list";

const TAB = "\t";

function tsv(rows: string[][]): string {
  return rows.map((row) => row.join(TAB)).join("\n");
}

const sixDebaters = [
  ["Coral Bay Academy", "Amara Bennett", "Compass"],
  ["Coral Bay Academy", "Theo Campbell", "Compass"],
  ["Harbourview College", "Leila Foster", "Lantern"],
  ["Harbourview College", "Marcus Grant", "Lantern"],
  ["Silver Palm High", "Nadia Hall", "Marlins"],
  ["Silver Palm High", "Elias James", "Marlins"],
];

describe("parseTeamList", () => {
  it("groups tab-separated rows without a header into teams with codes", () => {
    const result = parseTeamList(tsv(sixDebaters), { divisionCode: "Open" });
    expect(result.ok).toBe(true);
    expect(result.hasHeader).toBe(false);
    expect(result.delimiter).toBe(TAB);
    expect(result.teams.map((team) => [team.code, team.name, team.school])).toEqual([
      ["O01", "Compass", "Coral Bay Academy"],
      ["O02", "Lantern", "Harbourview College"],
      ["O03", "Marlins", "Silver Palm High"],
    ]);
    expect(result.teams[0].speakers).toEqual([
      { name: "Amara Bennett", position: 1 },
      { name: "Theo Campbell", position: 2 },
    ]);
    expect(result.teams[0].divisionCode).toBe("Open");
    expect(result.teams[0].row).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("reads comma-separated rows with a header in any column order", () => {
    const text = [
      "Team,Student Name,School",
      "Compass,Amara Bennett,Coral Bay Academy",
      "Compass,Theo Campbell,Coral Bay Academy",
    ].join("\n");
    const result = parseTeamList(text, { divisionCode: "Novice" });
    expect(result.hasHeader).toBe(true);
    expect(result.delimiter).toBe(",");
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].code).toBe("N01");
    expect(result.teams[0].school).toBe("Coral Bay Academy");
    expect(result.teams[0].speakers.map((s) => s.name)).toEqual(["Amara Bennett", "Theo Campbell"]);
  });

  it("reads a Division column from the header and issues codes per division", () => {
    const text = [
      "School;Debater;Team;Division",
      "Coral Bay Academy;Amara Bennett;Compass;Open",
      "Coral Bay Academy;Theo Campbell;Compass;Open",
      "Coral Bay Academy;Leila Foster;Compass;Novice",
      "Coral Bay Academy;Marcus Grant;Compass;Novice",
    ].join("\n");
    const result = parseTeamList(text);
    expect(result.delimiter).toBe(";");
    expect(result.teams.map((team) => [team.code, team.divisionCode])).toEqual([
      ["O01", "Open"],
      ["N01", "Novice"],
    ]);
  });

  it("matches a Division column against the tournament's divisions and writes back the code", () => {
    const divisions = [
      { code: "Open", name: "Open (competitive)" },
      { code: "Novice", name: "Novice (learning)" },
    ];
    const text = [
      "School;Debater;Team;Division",
      "Coral Bay Academy;Amara Bennett;Compass;open",
      "Coral Bay Academy;Theo Campbell;Compass;OPEN ",
      "Harbourview College;Leila Foster;Lantern;Novice (learning)",
      "Harbourview College;Marcus Grant;Lantern;novice",
      "Silver Palm High;Nadia Hall;Marlins;Opne",
    ].join("\n");
    const result = parseTeamList(text, { divisions });
    expect(result.ok).toBe(false);
    expect(result.teams.map((team) => [team.code, team.divisionCode])).toEqual([
      ["O01", "Open"],
      ["N01", "Novice"],
    ]);
    expect(result.issues).toContainEqual({
      row: 6,
      level: "error",
      message: 'Row 6: division "Opne" is not one of Open, Novice.',
    });
  });

  it("matches the paste's default division the same way", () => {
    const divisions = [{ code: "Open" }, { code: "Novice" }];
    const result = parseTeamList(tsv(sixDebaters.slice(0, 2)), {
      divisionCode: "novice",
      divisions,
    });
    expect(result.ok).toBe(true);
    expect(result.teams[0].divisionCode).toBe("Novice");
    expect(result.teams[0].code).toBe("N01");
  });

  it("trims trailing spaces and collapses inner whitespace", () => {
    const text = tsv([
      ["  Coral Bay   Academy ", "Amara  Bennett ", " Compass  "],
      ["Coral Bay Academy", "Theo Campbell", "Compass"],
    ]);
    const result = parseTeamList(text, { divisionCode: "Open" });
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].school).toBe("Coral Bay Academy");
    expect(result.teams[0].speakers[0].name).toBe("Amara Bennett");
  });

  it("keeps quoted cells that contain the delimiter", () => {
    const text = [
      '"Bay, Coral Academy",Amara Bennett,Compass',
      '"Bay, Coral Academy",Theo Campbell,Compass',
    ].join("\n");
    const result = parseTeamList(text, { divisionCode: "Open" });
    expect(result.teams[0].school).toBe("Bay, Coral Academy");
  });

  it("skips blank lines and keeps the original line numbers", () => {
    const text = [
      "",
      "Coral Bay Academy\tAmara Bennett\tCompass",
      "",
      "Coral Bay Academy\tTheo Campbell\tCompass",
      "Harbourview College\tLeila Foster\tLantern",
    ].join("\n");
    const result = parseTeamList(text, { divisionCode: "Open" });
    expect(result.teams[0].row).toBe(2);
    expect(result.teams[1].row).toBe(5);
    expect(result.issues[0]).toEqual({
      row: 5,
      level: "warning",
      message:
        "Only one debater listed for team Lantern (Harbourview College). Add a partner, or continue with one.",
    });
  });

  it("warns about a one-debater team but still succeeds", () => {
    const result = parseTeamList(tsv([sixDebaters[0]]), { divisionCode: "Open" });
    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => issue.level)).toEqual(["warning"]);
    expect(result.teams[0].speakers).toHaveLength(1);
  });

  it("reports three debaters on one team as an error", () => {
    const rows = [...sixDebaters.slice(0, 2), ["Coral Bay Academy", "Nadia Hall", "Compass"]];
    const result = parseTeamList(tsv(rows), { divisionCode: "Open" });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        row: 1,
        level: "error",
        message: "3 debaters listed for team Compass (Coral Bay Academy). A team has two debaters.",
      },
    ]);
    expect(result.teams[0].speakers).toHaveLength(2);
  });

  it("reports a debater listed twice for the same team", () => {
    const rows = [
      sixDebaters[0],
      ["Coral Bay Academy", "amara bennett", "Compass"],
      sixDebaters[1],
    ];
    const result = parseTeamList(tsv(rows), { divisionCode: "Open" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toEqual({
      row: 2,
      level: "error",
      message: "Row 2: amara bennett is listed twice for team Compass (Coral Bay Academy).",
    });
    expect(result.teams[0].speakers.map((s) => s.name)).toEqual(["Amara Bennett", "Theo Campbell"]);
  });

  it("flags a possible duplicate of an existing team", () => {
    const result = parseTeamList(tsv(sixDebaters.slice(0, 2)), {
      divisionCode: "Open",
      existingTeams: [{ school: "coral bay academy", name: "COMPASS" }],
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      {
        row: 1,
        level: "warning",
        message: "Team Compass (Coral Bay Academy) looks like a duplicate of an existing team.",
      },
    ]);
  });

  it("skips codes that already exist", () => {
    const result = parseTeamList(tsv(sixDebaters), {
      divisionCode: "Open",
      existingCodes: ["O01", "o03"],
    });
    expect(result.teams.map((team) => team.code)).toEqual(["O02", "O04", "O05"]);
  });

  it("reports empty fields with their row", () => {
    const text = tsv([
      ["Coral Bay Academy", "", "Compass"],
      ["", "Theo Campbell", ""],
    ]);
    const result = parseTeamList(text, { divisionCode: "Open" });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { row: 1, level: "error", message: "Row 1: the debater is missing." },
      { row: 2, level: "error", message: "Row 2: the school is missing." },
      { row: 2, level: "error", message: "Row 2: the team is missing." },
    ]);
    expect(result.teams).toEqual([]);
  });

  it("reports a row with too few columns", () => {
    const result = parseTeamList("Coral Bay Academy\tAmara Bennett", { divisionCode: "Open" });
    expect(result.issues[0].message).toBe(
      "Row 1: expected school, debater and team separated by tabs.",
    );
  });

  it("needs a division from somewhere", () => {
    const result = parseTeamList(tsv(sixDebaters.slice(0, 2)));
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("no division given");
  });

  it("reports an empty paste", () => {
    const result = parseTeamList("  \n\n", { divisionCode: "Open" });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { row: 0, level: "error", message: "Nothing to import. Paste one debater per line." },
    ]);
  });
});

describe("helpers", () => {
  it("detects the most common delimiter and prefers tabs on a tie", () => {
    expect(detectDelimiter(["a,b,c", "d,e,f"])).toBe(",");
    expect(detectDelimiter(["a;b", "c;d"])).toBe(";");
    expect(detectDelimiter(["a\tb", "c,d"])).toBe(TAB);
    expect(detectDelimiter(["plain"])).toBe(TAB);
  });

  it("splits quoted cells and unescapes doubled quotes", () => {
    expect(splitRow('"Say ""hi"", please",b', ",")).toEqual(['Say "hi", please', "b"]);
  });

  it("tidies whitespace", () => {
    expect(tidy("  a \t b  ")).toBe("a b");
  });

  it("derives code prefixes from the division", () => {
    expect(codePrefix("Open")).toBe("O");
    expect(codePrefix("novice")).toBe("N");
    expect(codePrefix("1st")).toBe("T");
    expect(codePrefix("")).toBe("T");
  });

  it("matches a division by code or name, or passes the value through with no list", () => {
    const divisions = [{ code: "Open", name: "Open (competitive)" }];
    expect(matchDivision("open", divisions)).toBe("Open");
    expect(matchDivision(" open (COMPETITIVE) ", divisions)).toBe("Open");
    expect(matchDivision("Opne", divisions)).toBeNull();
    expect(matchDivision("Opne")).toBe("Opne");
  });

  it("issues sequential codes per division", () => {
    const issuer = new CodeIssuer(["O02"]);
    expect([
      issuer.next("Open"),
      issuer.next("Open"),
      issuer.next("Novice"),
      issuer.next("Open"),
    ]).toEqual(["O01", "O03", "N01", "O04"]);
  });
});
