/**
 * Generates the workbook golden fixture:
 *
 *   tests/fixtures/workbook-golden.json  (inputs + expected outputs)
 *   tests/fixtures/workbook-golden.csv   (the same rows laid out like the
 *                                         director's Master Sheet, for a
 *                                         one-off check in a real spreadsheet)
 *
 * Run:  pnpm exec tsx tests/fixtures/generate-workbook-golden.ts
 *
 * Every name and every score is invented. The data is produced from a fixed
 * seed, so running the script again gives byte-identical files. The expected
 * outputs come from the test-only Excel emulator, never from the scoring
 * engine, so the fixture stays an independent check on the engine.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AVERAGEIFS,
  DIV0,
  criterion,
  evaluateMasterSheet,
  type Cell,
  type MasterRow,
} from "../unit/scoring/excel-emulator";

const SEED = 20260916;
const ROUNDS = [1, 2, 3];
const SLOTS = 5;
const TEAM_COUNT = 20;
const ROGUE_COUNT = 4;

// ---------------------------------------------------------------- randomness

/** mulberry32: small, fast and good enough for fixtures. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = prng(SEED);
const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
const gaussian = (mean: number, sd: number): number => {
  const u = 1 - random();
  const v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

// ---------------------------------------------------------------- invented people

const FIRST_NAMES = [
  "Aurelia",
  "Bram",
  "Cassia",
  "Dorian",
  "Elowen",
  "Fenwick",
  "Gilda",
  "Hollis",
  "Isolde",
  "Jasper",
  "Kerensa",
  "Lucian",
  "Marigold",
  "Nestor",
  "Ottilie",
  "Perrin",
  "Quilla",
  "Rafferty",
  "Sabine",
  "Tobias",
  "Ulla",
  "Vesper",
  "Wilfred",
  "Xanthe",
  "Yorick",
  "Zelda",
  "Ambrose",
  "Beatrix",
  "Cormac",
  "Delphine",
  "Evander",
  "Fern",
  "Gideon",
  "Harriet",
  "Ignatius",
  "Juniper",
  "Kit",
  "Leopold",
  "Maude",
  "Nico",
];
const SURNAMES = [
  "Ashcombe",
  "Brightwater",
  "Calloway",
  "Dunmore",
  "Everleigh",
  "Fairweather",
  "Greyson",
  "Hawthorne",
  "Inglewood",
  "Kestrel",
  "Lockridge",
  "Merriweather",
  "Northcote",
  "Oakhurst",
  "Pemberton",
  "Quennell",
  "Ravenscroft",
  "Silverton",
  "Thornbury",
  "Underhill",
];
const SCHOOLS = [
  "Harbourview Academy",
  "Northgate School",
  "Saltmarsh College",
  "Ridgeway High",
  "Lantern Hill School",
  "Cedarbrook Academy",
  "Kingfisher School",
  "Westmere College",
  "Palmgrove High",
  "Coral Bay School",
];
const JUDGE_NAMES = [
  "Ada Winterbourne",
  "Rowan Falconer",
  "Imogen Castellane",
  "Bartholomew Nightingale",
  "Clemency Holloway",
  "Digby Marchbanks",
  "Eulalie Trask",
  "Fitzgerald Amory",
  "Ginevra Stoke",
  "Horatio Blunt",
  "Isadora Fenn",
  "Jocelyn Pryor",
  "Kasimir Wolde",
  "Lettice Barrow",
  "Montague Reeve",
];

const pad = (n: number): string => String(n).padStart(2, "0");

const judges = JUDGE_NAMES.map((name, index) => ({
  id: `judge-${pad(index + 1)}`,
  code: `J${pad(index + 1)}`,
  name,
}));

const teams = Array.from({ length: TEAM_COUNT }, (_, index) => {
  const school = SCHOOLS[index % SCHOOLS.length];
  const letter = index < SCHOOLS.length ? "A" : "B";
  return {
    id: `team-${pad(index + 1)}`,
    code: `O${pad(index + 1)}`,
    name: `${school.split(" ")[0]} ${letter}`,
    school,
    debaterIds: [`d-${pad(index * 2 + 1)}`, `d-${pad(index * 2 + 2)}`],
  };
});

const debaters = teams.flatMap((team, teamIndex) =>
  team.debaterIds.map((id, position) => ({
    id,
    name: `${FIRST_NAMES[teamIndex * 2 + position]} ${SURNAMES[(teamIndex * 2 + position) % SURNAMES.length]}`,
    teamId: team.id,
    position: (position + 1) as 1 | 2,
  })),
);

// ---------------------------------------------------------------- scores

interface Slot {
  judgeId: string;
  value: number;
}

const ability = new Map(debaters.map((d) => [d.id, clamp(gaussian(78, 6), 55, 95)]));
const bias = new Map(judges.map((j) => [j.id, gaussian(0, 2)]));
const PANEL_SIZES = [2, 3, 3, 3, 4, 5];

/** The judges in each team's room, per round: teammates share a panel. */
const panels = new Map<string, string[]>();
for (const team of teams) {
  for (const round of ROUNDS) {
    const size = pick(PANEL_SIZES);
    const pool = judges.map((j) => j.id);
    const panel: string[] = [];
    while (panel.length < size) {
      const index = Math.floor(random() * pool.length);
      panel.push(pool.splice(index, 1)[0]);
    }
    panels.set(`${team.id}:${round}`, panel);
  }
}

const rows = debaters.map((debater) => ({
  debaterId: debater.id,
  rounds: ROUNDS.map((round) => {
    const panel = panels.get(`${debater.teamId}:${round}`) ?? [];
    const slots: (Slot | null)[] = panel.map((judgeId) => ({
      judgeId,
      value: Math.round(
        clamp((ability.get(debater.id) ?? 78) + (bias.get(judgeId) ?? 0) + gaussian(0, 3), 40, 103),
      ),
    }));
    while (slots.length < SLOTS) slots.push(null);
    return slots;
  }),
}));

// Plant a few rogue scores in rooms with at least three judges, so the
// fixture has "set aside" cases a director can see.
let planted = 0;
while (planted < ROGUE_COUNT) {
  const row = pick(rows);
  const roundIndex = Math.floor(random() * ROUNDS.length);
  const slots = row.rounds[roundIndex];
  const filled = slots.filter((slot): slot is Slot => slot !== null);
  if (filled.length < 3) continue;
  const target = pick(filled);
  if (target.value === 40 || target.value === 103) continue;
  target.value = planted % 2 === 0 ? 40 : 103;
  planted += 1;
}

// ---------------------------------------------------------------- expected outputs (emulator)

const masterRows: MasterRow[] = rows.map((row) => ({
  debaterId: row.debaterId,
  teamId: debaters.find((d) => d.id === row.debaterId)?.teamId ?? "",
  rounds: row.rounds.map((slots) => slots.map((slot): Cell => (slot ? slot.value : null))),
}));
const evaluated = evaluateMasterSheet(masterRows);

const expectedDebaters = evaluated.map((result, index) => {
  const setAside = rows[index].rounds.flatMap((slots, roundIndex) =>
    slots.flatMap((slot) => {
      if (!slot) return [];
      const cell = [slot.value];
      const kept = AVERAGEIFS(
        cell,
        [cell, criterion("<", result.upper)],
        [cell, criterion(">", result.lower)],
      );
      return kept === DIV0
        ? [{ round: ROUNDS[roundIndex], judgeId: slot.judgeId, value: slot.value }]
        : [];
    }),
  );
  return {
    id: result.debaterId,
    mean: result.mean,
    sd: result.sd,
    upper: result.upper,
    lower: result.lower,
    roundAverages: result.roundAverages,
    roundRanks: result.roundRanks,
    total: result.total,
    rank: result.rank,
    setAside,
  };
});

const expectedTeams = teams.map((team) => {
  const first = evaluated.find((r) => r.teamId === team.id);
  return {
    id: team.id,
    roundTeamScores: first?.roundTeamScores ?? [],
    roundTeamRanks: first?.roundTeamRanks ?? [],
    total: first?.teamTotal ?? DIV0,
    rank: first?.teamRank ?? DIV0,
  };
});

// A golden must be unambiguous in a real spreadsheet: no #DIV/0! anywhere
// (RANK.EQ over a range with an error is the one thing we cannot emulate)
// and enough set-aside scores to be worth looking at.
const anyError = [...expectedDebaters, ...expectedTeams].some((entry) =>
  JSON.stringify(entry).includes(DIV0),
);
const setAsideCount = expectedDebaters.reduce((sum, d) => sum + d.setAside.length, 0);
if (anyError) throw new Error("golden has a #DIV/0! cell; choose another seed");
if (setAsideCount < 3)
  throw new Error(`golden has only ${setAsideCount} set-aside scores; choose another seed`);

// ---------------------------------------------------------------- write JSON

const fixture = {
  title: "Dais workbook golden fixture",
  description:
    "Forty invented debaters, three rounds, up to five judges per round. Expected values come from the test-only Excel emulator (AVERAGE, STDEV.S, AVERAGEIFS with strict text criteria, SUM, RANK.EQ). Regenerate with tests/fixtures/generate-workbook-golden.ts.",
  generator: "tests/fixtures/generate-workbook-golden.ts",
  seed: SEED,
  rounds: ROUNDS,
  slotsPerRound: SLOTS,
  policy: {
    sdMultiplier: 2,
    bounds: "strict",
    scope: "pooled",
    passes: "one",
    sd: "sample",
    whenUndefined: "unresolved",
    zeroSpread: "unresolved",
    excelCriteriaRounding: true,
  },
  judges,
  teams,
  debaters,
  rows,
  expected: { debaters: expectedDebaters, teams: expectedTeams },
};

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "workbook-golden.json"), `${JSON.stringify(fixture, null, 2)}\n`);

// ---------------------------------------------------------------- write CSV (Master Sheet layout)

const judgeCode = new Map(judges.map((j) => [j.id, j.code]));
const csvCell = (value: string | number | null): string => {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};

const roundBlock = (round: number): string[] => [
  ...Array.from({ length: SLOTS }, (_, slot) => [
    `R${round} J${slot + 1} code`,
    `R${round} J${slot + 1} score`,
  ]).flat(),
  `R${round} average`,
  `R${round} team score`,
  `R${round} rank`,
  `R${round} team rank`,
];
const header = [
  "School",
  "Pair",
  "Team",
  "Code",
  "Debater",
  ...ROUNDS.flatMap(roundBlock),
  "Notes",
  "Average",
  "Spread (STDEV.S)",
  "+2 SD",
  "-2 SD",
  "Individual total",
  "Team total",
  "Individual rank",
  "Team rank",
];
const groupHeader = header.map((_, index) => {
  if (index < 5) return "";
  const offset = index - 5;
  if (offset < ROUNDS.length * 14)
    return offset % 14 === 0 ? `Round ${ROUNDS[Math.floor(offset / 14)]}` : "";
  return offset === ROUNDS.length * 14 + 1 ? "All rounds" : "";
});

const lines: string[] = [
  csvCell(
    `Dais workbook golden fixture (invented data). Generated by tests/fixtures/generate-workbook-golden.ts with seed ${SEED}. Rows 5-44 hold one debater each, teammates on adjacent rows; see docs/SCORING.md for the formulas to type.`,
  ),
  "",
  groupHeader.map(csvCell).join(","),
  header.map(csvCell).join(","),
];

rows.forEach((row, index) => {
  const debater = debaters[index];
  const team = teams.find((t) => t.id === debater.teamId);
  const expected = expectedDebaters[index];
  const expectedTeam = expectedTeams.find((t) => t.id === debater.teamId);
  const cells: (string | number | null)[] = [
    team?.school ?? "",
    `Pair ${pad(Math.floor(index / 2) + 1)}`,
    team?.name ?? "",
    team?.code ?? "",
    debater.name,
  ];
  ROUNDS.forEach((round, roundIndex) => {
    for (const slot of row.rounds[roundIndex]) {
      cells.push(slot ? (judgeCode.get(slot.judgeId) ?? "") : null, slot ? slot.value : null);
    }
    cells.push(
      expected.roundAverages[roundIndex] as number,
      expectedTeam?.roundTeamScores[roundIndex] as number,
      expected.roundRanks[roundIndex] as number,
      expectedTeam?.roundTeamRanks[roundIndex] as number,
    );
  });
  cells.push(
    null,
    expected.mean as number,
    expected.sd as number,
    expected.upper as number,
    expected.lower as number,
    expected.total as number,
    expectedTeam?.total as number,
    expected.rank as number,
    expectedTeam?.rank as number,
  );
  lines.push(cells.map(csvCell).join(","));
});

writeFileSync(join(here, "workbook-golden.csv"), `${lines.join("\r\n")}\r\n`);

console.log(
  `wrote workbook-golden.json and workbook-golden.csv: ${debaters.length} debaters, ${setAsideCount} scores set aside, no #DIV/0! cells`,
);
