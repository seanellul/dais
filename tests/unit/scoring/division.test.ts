/**
 * Division-level behaviour: partial ranking, teams keyed by id, overrides,
 * waivers, ties, the top-two selection and per-judge attribution.
 */

import { describe, expect, it } from "vitest";
import {
  WORKBOOK_POLICY,
  computeDivisionResults,
  describePolicy,
  selectTop,
  type Override,
  type TeamResult,
} from "@/domain/scoring";
import { BLUE, DEBATERS, RED, division, roundsFor, sheet } from "./helpers";

const single = (id: "a" | "b" | "c" | "d") => ({
  debaters: DEBATERS.filter((d) => d.id === id),
  teams: [{ ...(id === "a" || id === "b" ? RED : BLUE), debaterIds: [id] }],
});

const redOnly = { debaters: DEBATERS.filter((d) => d.teamId === RED.id), teams: [RED] };

describe("partial ranking", () => {
  it("ranks the ready debaters and lists the one that can't be scored yet", () => {
    const input = division(roundsFor({ a: [10, 20, 30], b: [7, 7, 7] }), {
      debaters: DEBATERS.filter((d) => d.id === "a" || d.id === "b"),
      teams: [RED],
    });
    const result = computeDivisionResults(input);
    const [a, b] = result.debaters;
    expect(a).toMatchObject({ id: "a", total: 60, rank: 1, status: "ready" });
    expect(b).toMatchObject({ id: "b", total: null, rank: null, status: "unresolved" });
    expect(b.rounds.every((round) => round.reason === "zero_spread")).toBe(true);
    expect(b.reasons).toEqual([
      "Every score across all rounds is the same, so the spread is zero and the kept range keeps nothing.",
    ]);
    expect(result.ranking.rankedDebaters).toEqual(["a"]);
    expect(result.ranking.unrankedDebaters).toEqual([{ id: "b", reasons: b.reasons }]);
    expect(result.teams[0]).toMatchObject({ status: "unresolved", total: null, rank: null });
    expect(result.teams[0].reasons).toEqual(["Bram Brightwater can't be scored yet."]);
    expect(result.completeness.finalizable).toBe(false);
    expect(result.completeness.blockers[0]).toContain("Bram Brightwater can't be scored yet.");
  });

  it("ignores scores for unknown debaters or rounds outside the division", () => {
    const input = division(roundsFor({ a: [10, 20, 30], c: [20, 10, 20] }), {
      ...single("a"),
      teams: [{ ...RED, debaterIds: ["a"] }],
    });
    input.scores.push({ ...input.scores[0], round: 9, value: 999 });
    input.overrides = [
      { id: "ov", kind: "rank_single_speaker_team", teamId: RED.id, reason: "solo" },
    ];
    const result = computeDivisionResults(input);
    expect(result.debaters).toHaveLength(1);
    expect(result.debaters[0].total).toBe(60);
    expect(result.debaters[0].rounds.map((round) => round.round)).toEqual([1, 2, 3]);
  });
});

describe("teams", () => {
  it("are keyed by id, so 'Red' and 'Red ' cannot split a team", () => {
    const redSpace = { ...BLUE, name: "Red " };
    const input = division(
      roundsFor({ a: [10, 20, 30], b: [10, 20, 30], c: [5, 5, 10], d: [5, 5, 10] }),
      {
        teams: [RED, redSpace],
      },
    );
    const result = computeDivisionResults(input);
    expect(result.teams.map((t) => [t.id, t.name, t.members, t.total])).toEqual([
      [RED.id, "Red", ["a", "b"], 120],
      [BLUE.id, "Red ", ["c", "d"], 40],
    ]);
    // A debater whose teamId points at a team is a member even if the team's list forgot them.
    const forgetful = division(roundsFor({ a: [10, 20, 30], b: [10, 20, 30] }), {
      debaters: DEBATERS.filter((d) => d.teamId === RED.id),
      teams: [{ ...RED, debaterIds: ["a"] }],
    });
    expect(computeDivisionResults(forgetful).teams[0].members).toEqual(["a", "b"]);
  });

  it("needs rank_single_speaker_team before a one-person team is ranked", () => {
    const input = division(roundsFor({ a: [10, 20, 30] }), single("a"));
    const before = computeDivisionResults(input);
    expect(before.teams[0]).toMatchObject({ status: "incomplete", total: null, rank: null });
    expect(before.completeness.finalizable).toBe(false);
    expect(before.completeness.blockers).toEqual([
      "Red (O01): Only one debater on this team. The organiser can rank it on that one total or leave it unranked.",
    ]);

    input.overrides = [
      { id: "ov", kind: "rank_single_speaker_team", teamId: RED.id, reason: "partner withdrew" },
    ];
    const after = computeDivisionResults(input);
    expect(after.teams[0]).toMatchObject({ status: "ready", total: 60, rank: 1 });
    expect(after.completeness.finalizable).toBe(true);
  });
});

describe("overrides", () => {
  const rogueRound3 = [
    { round: 1, judgeId: "j1", judgeName: "Ada Winterbourne", scores: { a: 78, b: 80 } },
    { round: 1, judgeId: "j2", judgeName: "Rowan Falconer", scores: { a: 84, b: 82 } },
    { round: 1, judgeId: "j3", judgeName: "Imogen Castellane", scores: { a: 81, b: 79 } },
    { round: 2, judgeId: "j1", judgeName: "Ada Winterbourne", scores: { a: 85, b: 83 } },
    { round: 2, judgeId: "j2", judgeName: "Rowan Falconer", scores: { a: 79, b: 80 } },
    { round: 2, judgeId: "j3", judgeName: "Imogen Castellane", scores: { a: 88, b: 84 } },
    { round: 3, judgeId: "j1", judgeName: "Ada Winterbourne", scores: { a: 90, b: 86 } },
    { round: 3, judgeId: "j2", judgeName: "Rowan Falconer", scores: { a: 83, b: 81 } },
    { round: 3, judgeId: "j3", judgeName: "Imogen Castellane", scores: { a: 40, b: 85 } },
  ];

  it("names the judge whose score was set aside", () => {
    const result = computeDivisionResults(division(rogueRound3, redOnly));
    const a = result.debaters[0];
    const setAside = a.rounds
      .flatMap((round) => round.sources)
      .filter((s) => s.status === "lopped");
    expect(setAside).toHaveLength(1);
    expect(setAside[0]).toMatchObject({
      judgeName: "Imogen Castellane",
      value: 40,
      round: 3,
      pass: 1,
    });
    expect(a.rounds[2].average).toBe((90 + 83) / 2);
  });

  it("force_include keeps a set-aside score and force_exclude sets a kept one aside", () => {
    const include: Override = {
      id: "ov-in",
      kind: "force_include",
      debaterId: "a",
      assignmentId: "asg-r3-j3",
      reason: "judge confirmed the 40 was deliberate",
    };
    const exclude: Override = {
      id: "ov-out",
      kind: "force_exclude",
      debaterId: "a",
      assignmentId: "asg-r3-j1",
      reason: "judge scored the wrong debater",
    };
    const result = computeDivisionResults(
      division(rogueRound3, { ...redOnly, overrides: [include, exclude] }),
    );
    const a = result.debaters[0];
    const round3 = a.rounds[2];
    expect(round3.sources.map((s) => [s.judgeId, s.status, s.overrideId])).toEqual([
      ["j1", "forced_out", "ov-out"],
      ["j2", "retained", undefined],
      ["j3", "forced_in", "ov-in"],
    ]);
    expect(round3.average).toBe((83 + 40) / 2);
    expect(a.overrides).toEqual([include, exclude]);
    // Debater b's scores on the same sheets are untouched.
    expect(result.debaters[1].rounds[2].sources.every((s) => s.status === "retained")).toBe(true);
  });

  it("force_exclude without a debaterId touches nothing, because a sheet covers the whole room", () => {
    const wholeSheet: Override = {
      id: "ov-sheet",
      kind: "force_exclude",
      assignmentId: "asg-r3-j1",
      reason: "meant to name one debater",
    };
    const result = computeDivisionResults(
      division(rogueRound3, { ...redOnly, overrides: [wholeSheet] }),
    );
    const untouched = computeDivisionResults(division(rogueRound3, redOnly));
    expect(result.debaters.map((d) => d.rounds)).toEqual(untouched.debaters.map((d) => d.rounds));
    expect(result.debaters.every((d) => d.overrides.length === 0)).toBe(true);
  });

  it("keeps the highest sheet version when the same score is passed twice", () => {
    const input = division(roundsFor({ a: [10, 20, 30], b: [9, 9, 12] }), redOnly);
    const first = input.scores.find((s) => s.debaterId === "a" && s.round === 1);
    if (!first) throw new Error("fixture has no round 1 score for a");
    input.scores.push({ ...first, value: 15, sheetVersion: 2 }); // corrected on the desk
    input.scores.push({ ...first }); // the old row replayed by a sync
    const a = computeDivisionResults(input).debaters[0];
    expect(a.rounds[0].sources.map((s) => [s.value, s.sheetVersion])).toEqual([[15, 2]]);
    expect(a.stats).toMatchObject({ scope: "pooled", n: 3 });
    expect(a.total).toBe(65);
  });

  it("keep_all_for_debater resolves a zero-spread debater without changing the policy", () => {
    const keepAll: Override = {
      id: "ov-keep",
      kind: "keep_all_for_debater",
      debaterId: "b",
      reason: "one judge all day",
    };
    const input = division(roundsFor({ a: [10, 20, 30], b: [7, 7, 7] }), {
      ...redOnly,
      overrides: [keepAll],
    });
    const b = computeDivisionResults(input).debaters[1];
    expect(b).toMatchObject({ status: "ready", total: 21, rank: 2 });
    expect(b.rounds.flatMap((r) => r.sources).map((s) => s.status)).toEqual([
      "forced_in",
      "forced_in",
      "forced_in",
    ]);
    expect(b.stats).toMatchObject({ scope: "pooled", sd: 0 });
  });

  const excludeA: Override = {
    id: "ov-x",
    kind: "exclude_debater",
    debaterId: "a",
    reason: "spoke in the wrong division",
  };
  const rankRedAlone: Override = {
    id: "ov-solo",
    kind: "rank_single_speaker_team",
    teamId: RED.id,
    reason: "rank Red on Bram alone",
  };

  it("exclude_debater takes a debater out and asks the organiser to decide about the team", () => {
    const input = division(roundsFor({ a: [10, 20, 30], b: [9, 9, 12] }), {
      ...redOnly,
      overrides: [excludeA],
    });
    const result = computeDivisionResults(input);
    expect(result.debaters[0]).toMatchObject({ status: "unresolved", total: null, rank: null });
    expect(result.debaters[0].reasons).toEqual([
      "Set aside from the ranking by the organiser: spoke in the wrong division",
    ]);
    expect(result.debaters[1].rank).toBe(1);
    expect(result.teams[0]).toMatchObject({ status: "incomplete", total: null, rank: null });
    expect(result.teams[0].reasons).toEqual([
      "Aurelia Ashcombe was taken out of the ranking by the organiser.",
      "Only one debater on this team. The organiser can rank it on that one total or leave it unranked.",
    ]);
    // The excluded debater is an explicit decision, not a blocker; the team still needs one.
    expect(result.completeness.blockers).toEqual([
      "Red (O01): Aurelia Ashcombe was taken out of the ranking by the organiser. Only one debater on this team. The organiser can rank it on that one total or leave it unranked.",
    ]);
    expect(result.top.resolved).toBe(false);
  });

  it("exclude_debater with rank_single_speaker_team ranks the team on the other debater", () => {
    const input = division(roundsFor({ a: [10, 20, 30], b: [9, 9, 12] }), {
      ...redOnly,
      overrides: [excludeA, rankRedAlone],
      topN: 1,
    });
    const result = computeDivisionResults(input);
    expect(result.teams[0]).toMatchObject({ status: "ready", total: 30, rank: 1 });
    expect(result.teams[0].reasons).toEqual([
      "Aurelia Ashcombe was taken out of the ranking by the organiser.",
    ]);
    expect(result.completeness).toMatchObject({ finalizable: true, blockers: [] });
    expect(result.top).toEqual({ n: 1, teamIds: [RED.id], resolved: true, tieAtCut: null });
  });

  it("a team whose every debater was taken out is unranked without becoming a blocker", () => {
    const excludeB: Override = { ...excludeA, id: "ov-y", debaterId: "b" };
    const input = division(roundsFor({ a: [10, 20, 30], b: [9, 9, 12] }), {
      ...redOnly,
      overrides: [excludeA, excludeB],
    });
    const result = computeDivisionResults(input);
    expect(result.teams[0]).toMatchObject({ status: "unresolved", total: null, rank: null });
    expect(result.completeness.blockers).toEqual([]);
  });

  it("waive_missing_sheet removes a missing sheet from the blockers", () => {
    const sheets = [
      { round: 1, judgeId: "j1", scores: { a: 10, b: 12 } },
      {
        round: 1,
        judgeId: "j2",
        roomName: "Room 4",
        judgeName: "Clemency Holloway",
        scores: null,
        debaterIds: ["a", "b"],
      },
      { round: 2, judgeId: "j1", scores: { a: 20, b: 18 } },
      { round: 3, judgeId: "j1", scores: { a: 30, b: 24 } },
    ];
    const before = computeDivisionResults(division(sheets, redOnly));
    expect(before.completeness).toMatchObject({
      expected: 4,
      received: 3,
      provisional: true,
      finalizable: false,
    });
    expect(before.completeness.blockers).toEqual([
      "Round 1, Room 4: the sheet from Clemency Holloway has not been received by the tournament.",
    ]);
    expect(before.debaters.every((d) => d.provisional)).toBe(true);
    expect(before.teams[0].provisional).toBe(true);
    expect(before.top.resolved).toBe(false);

    const waiver: Override = {
      id: "ov-w",
      kind: "waive_missing_sheet",
      assignmentId: "asg-r1-j2",
      reason: "judge left early",
    };
    const after = computeDivisionResults(division(sheets, { ...redOnly, overrides: [waiver] }));
    expect(after.completeness).toMatchObject({
      expected: 4,
      received: 3,
      provisional: false,
      finalizable: true,
    });
    expect(after.completeness.missing).toEqual([
      {
        assignmentId: "asg-r1-j2",
        judgeName: "Clemency Holloway",
        round: 1,
        roomName: "Room 4",
        waived: true,
      },
    ]);
    expect(after.debaters.every((d) => !d.provisional)).toBe(true);
  });

  it("counts orphaned sheets separately and never as expected", () => {
    const sheets = [
      ...roundsFor({ a: [10, 20, 30], b: [9, 9, 12] }),
      { round: 2, judgeId: "old", scores: null, debaterIds: ["a", "b"], orphaned: true },
    ];
    const result = computeDivisionResults(division(sheets, redOnly));
    expect(result.completeness).toMatchObject({
      expected: 3,
      received: 3,
      orphaned: ["asg-r2-old"],
      provisional: false,
    });
  });
});

describe("ties and the top-two selection", () => {
  it("keeps RANK.EQ gaps and lists a tie at rank 1", () => {
    const input = division(
      roundsFor({ a: [10, 20, 30], b: [30, 20, 10], c: [10, 20, 20], d: [30, 10, 10] }),
    );
    const result = computeDivisionResults(input);
    expect(result.debaters.map((d) => [d.id, d.total, d.rank])).toEqual([
      ["a", 60, 1],
      ["b", 60, 1],
      ["c", 50, 3],
      ["d", 50, 3],
    ]);
    expect(result.debaters[0].tiedWith).toEqual(["b"]);
    expect(result.ties).toEqual([
      { scope: "debater", rank: 1, ids: ["a", "b"] },
      { scope: "debater", rank: 3, ids: ["c", "d"] },
    ]);
    expect(result.ranking.rankedDebaters).toEqual(["a", "b", "c", "d"]);
  });

  it("ties two debaters whose equal totals were summed in a different round order", () => {
    // Three judges per round. Aurelia's round averages are 80, 80⅓, 80⅓ and
    // Bram's are 80⅓, 80⅓, 80: the same total, one unit apart in doubles.
    const sheets = [
      { round: 1, judgeId: "j1", scores: { a: 80, b: 80 } },
      { round: 1, judgeId: "j2", scores: { a: 80, b: 80 } },
      { round: 1, judgeId: "j3", scores: { a: 80, b: 81 } },
      { round: 2, judgeId: "j1", scores: { a: 80, b: 80 } },
      { round: 2, judgeId: "j2", scores: { a: 80, b: 80 } },
      { round: 2, judgeId: "j3", scores: { a: 81, b: 81 } },
      { round: 3, judgeId: "j1", scores: { a: 80, b: 80 } },
      { round: 3, judgeId: "j2", scores: { a: 80, b: 80 } },
      { round: 3, judgeId: "j3", scores: { a: 81, b: 80 } },
    ];
    const solo = (teamId: string): Override => ({
      id: `ov-${teamId}`,
      kind: "rank_single_speaker_team",
      teamId,
      reason: "partner withdrew",
    });
    const input = division(sheets, {
      debaters: [
        { id: "a", name: "Aurelia Ashcombe", teamId: RED.id, position: 1 },
        { id: "b", name: "Bram Brightwater", teamId: BLUE.id, position: 1 },
      ],
      teams: [
        { ...RED, debaterIds: ["a"] },
        { ...BLUE, debaterIds: ["b"] },
      ],
      overrides: [solo(RED.id), solo(BLUE.id)],
      topN: 1,
    });
    const result = computeDivisionResults(input);
    const [a, b] = result.debaters;
    expect(a.total).not.toBe(b.total); // the doubles differ...
    expect([a.rank, b.rank]).toEqual([1, 1]); // ...but the totals are equal
    expect(a.tiedWith).toEqual(["b"]);
    expect(result.ties).toEqual([
      { scope: "debater", rank: 1, ids: ["a", "b"] },
      { scope: "team", rank: 1, ids: [RED.id, BLUE.id] },
    ]);
    // The cut is a tie, so nobody goes through without the organiser's say.
    expect(result.top).toEqual({
      n: 1,
      teamIds: [],
      resolved: false,
      tieAtCut: { rank: 1, teamIds: [RED.id, BLUE.id] },
    });
  });

  const team = (
    id: string,
    total: number | null,
    rank: number | null,
    extra: Partial<TeamResult> = {},
  ): TeamResult => ({
    id,
    code: id,
    name: id,
    school: "Harbourview Academy",
    members: [],
    total,
    rank,
    tiedWith: [],
    status: "ready",
    reasons: [],
    provisional: false,
    ...extra,
  });

  it("flags a tie at the cut and never breaks it automatically", () => {
    const teams = [team("T1", 120, 1), team("T2", 100, 2), team("T3", 100, 2), team("T4", 90, 4)];
    expect(selectTop(teams, 2)).toEqual({
      n: 2,
      teamIds: ["T1"],
      resolved: false,
      tieAtCut: { rank: 2, teamIds: ["T2", "T3"] },
    });
    expect(selectTop([team("T1", 100, 1), team("T2", 100, 1), team("T3", 100, 1)], 2)).toEqual({
      n: 2,
      teamIds: [],
      resolved: false,
      tieAtCut: { rank: 1, teamIds: ["T1", "T2", "T3"] },
    });
  });

  it("resolves when exactly n teams are through, even if the two are tied with each other", () => {
    expect(selectTop([team("T1", 120, 1), team("T2", 110, 2), team("T3", 100, 3)], 2)).toEqual({
      n: 2,
      teamIds: ["T1", "T2"],
      resolved: true,
      tieAtCut: null,
    });
    expect(
      selectTop([team("T1", 120, 1), team("T2", 120, 1), team("T3", 100, 3)], 2).resolved,
    ).toBe(true);
    expect(selectTop([team("T1", 120, 1)], 2)).toEqual({
      n: 2,
      teamIds: ["T1"],
      resolved: false,
      tieAtCut: null,
    });
    expect(selectTop([], 0)).toEqual({ n: 0, teamIds: [], resolved: true, tieAtCut: null });
  });

  it("is not resolved while a team is provisional, can't be scored yet or awaits a decision", () => {
    const provisional = [
      team("T1", 120, 1, { provisional: true }),
      team("T2", 110, 2),
      team("T3", 100, 3),
    ];
    expect(selectTop(provisional, 2).resolved).toBe(false);
    const waiting = [
      team("T1", 120, 1),
      team("T2", 110, 2),
      team("T3", null, null, { status: "unresolved" }),
    ];
    expect(selectTop(waiting, 2).resolved).toBe(false);
    // A one-person team the organiser has not decided about could still move the cut.
    const undecided = [
      team("T1", 120, 1),
      team("T2", 110, 2),
      team("T3", null, null, { status: "incomplete" }),
    ];
    expect(selectTop(undecided, 2)).toEqual({
      n: 2,
      teamIds: ["T1", "T2"],
      resolved: false,
      tieAtCut: null,
    });
  });

  it("wires selectTop into the division results", () => {
    const input = division(
      roundsFor({ a: [10, 20, 30], b: [30, 20, 10], c: [10, 20, 20], d: [30, 10, 10] }),
    );
    const result = computeDivisionResults(input);
    expect(result.top).toEqual({
      n: 2,
      teamIds: [RED.id, BLUE.id],
      resolved: true,
      tieAtCut: null,
    });
    expect(result.policyText).toBe(describePolicy(WORKBOOK_POLICY));
    expect(result.policy).toBe(WORKBOOK_POLICY);
  });
});

describe("expected sheets and rounds", () => {
  it("marks a round 'missing' only when a sheet for it is outstanding and nothing arrived", () => {
    const built = sheet({ round: 2, judgeId: "j1", scores: null, debaterIds: ["a"] });
    const input = division(
      [
        { round: 1, scores: { a: 10 } },
        { round: 3, scores: { a: 30 } },
      ],
      single("a"),
    );
    input.expectedSheets.push(built.expected);
    const debater = computeDivisionResults(input).debaters[0];
    expect(debater.rounds[1]).toMatchObject({
      round: 2,
      status: "missing",
      reason: "sheet_missing",
      average: null,
    });
    expect(debater.reasons).toEqual([
      "Round 2: a sheet has not been received by the tournament yet.",
    ]);
    expect(debater.provisional).toBe(true);
  });

  it("lists a missing sheet once, not again for every debater it covers", () => {
    const sheets = [
      { round: 1, scores: { a: 10, b: 12 } },
      { round: 2, judgeName: "Ada Winterbourne", scores: null, debaterIds: ["a", "b"] },
      { round: 3, scores: { a: 30, b: 24 } },
    ];
    const result = computeDivisionResults(division(sheets, redOnly));
    expect(result.completeness.blockers).toEqual([
      "Round 2, Room 1: the sheet from Ada Winterbourne has not been received by the tournament.",
    ]);
    // The debaters still carry the reason for their own trace.
    expect(result.debaters.map((d) => d.reasons)).toEqual([
      ["Round 2: a sheet has not been received by the tournament yet."],
      ["Round 2: a sheet has not been received by the tournament yet."],
    ]);
    expect(result.teams[0]).toMatchObject({ status: "unresolved", provisional: true });
  });
});
