import { describe, expect, it } from "vitest";
import { generateDraw } from "@/domain/draw";
import { dedupeByMessage, readiness, sortIssues, type ScheduleIssue } from "@/domain/schedule";
import {
  buildSchedule,
  clone,
  drawnSchedule,
  sampleJudge,
  sampleTeam,
} from "../draw/build-schedule";

const texts = (issues: ScheduleIssue[]) => issues.map((issue) => issue.message);

describe("readiness", () => {
  it("is empty for a complete, sound draw", () => {
    expect(readiness(drawnSchedule({ open: 8, rooms: 4 }), "Open")).toEqual([]);
  });

  it("counts teams up to the four-team minimum", () => {
    const s = buildSchedule({ open: 0, rooms: 0, judges: 0 });
    expect(texts(readiness(s, "Open"))).toEqual([
      "0 teams are listed; add 4 more to reach the four-team minimum.",
    ]);
    s.teams.push(sampleTeam("Open", 1));
    expect(texts(readiness(s, "Open"))).toEqual([
      "1 team is listed; add 3 more to reach the four-team minimum.",
    ]);
  });

  it("asks for an even number of teams", () => {
    const s = buildSchedule({ open: 5, rooms: 0, judges: 0 });
    expect(readiness(s, "Open")[0]).toMatchObject({
      code: "division.odd-teams",
      message: "Add one more team so the division has an even number of teams.",
      tab: "teams",
      severity: "blocker",
    });
  });

  it("warns about unallocated judges and rooms without a panel in fixed-room mode", () => {
    // Six teams need three rooms; Room 3 has no panel and two judges have no room.
    const s = buildSchedule({ open: 6, rooms: 2, judges: 2, judgesPerRoom: 1 });
    s.judges.push(sampleJudge(3), sampleJudge(4));
    s.rooms.push({ id: "room-03", name: "Room 3", sortOrder: 3 });
    const issues = readiness(s, "Open");
    expect(texts(issues)).toContain("2 judges are not allocated to a room yet.");
    expect(texts(issues)).toContain("Room 3 has no judges allocated yet.");
    expect(issues.filter((i) => i.tab === "judges").every((i) => i.severity === "warning")).toBe(
      true,
    );
    s.settings.panelMode = "per-round";
    expect(readiness(s, "Open").filter((i) => i.tab === "judges")).toEqual([]);
  });

  it("before the draw, looks only at the rooms the draw would pick", () => {
    // Eight teams need four rooms. Judges sit in rooms 3 to 6; rooms 1, 2, 7 and 8 stay empty and unused.
    const s = buildSchedule({
      open: 8,
      rooms: 8,
      judges: 8,
      judgesPerRoom: 2,
      allocateJudges: false,
    });
    for (const [index, judge] of s.judges.entries())
      judge.homeRoomId = s.rooms[2 + Math.floor(index / 2)].id;
    expect(readiness(s, "Open").filter((i) => i.tab === "judges")).toEqual([]);
    s.judges.push(sampleJudge(9));
    expect(readiness(s, "Open").filter((i) => i.tab === "judges")).toEqual([]);
    s.judges[0].homeRoomId = null;
    s.judges[1].homeRoomId = null;
    expect(texts(readiness(s, "Open").filter((i) => i.tab === "judges"))).toEqual([
      "3 judges are not allocated to a room yet.",
      "Room 1 has no judges allocated yet.",
    ]);
  });

  it("is empty for a drawn division with a spare room", () => {
    expect(readiness(drawnSchedule({ open: 8, rooms: 5 }), "Open")).toEqual([]);
  });

  it("is empty for a drawn division whose panels were topped up from reserve judges", () => {
    const s = buildSchedule({ open: 8, rooms: 4, judges: 4, judgesPerRoom: 1 });
    s.judges.push(sampleJudge(5), sampleJudge(6), sampleJudge(7), sampleJudge(8), sampleJudge(9));
    const result = generateDraw({
      schedule: s,
      divisionCodes: ["Open"],
      seed: "2026-TEST",
      method: "random",
      judgesPerRoom: 2,
    });
    if (!result.ok) throw new Error(result.error.message);
    // Judge 9 is a spare with no room; every room has a panel, so nothing needs attention.
    expect(readiness({ ...s, debates: result.debates }, "Open")).toEqual([]);
  });

  it("after a withdrawal on the day, points at the debates left short instead of asking for another team", () => {
    const s = clone(drawnSchedule({ open: 8, rooms: 4 }));
    s.teams[0].status = "withdrawn";
    const issues = readiness(s, "Open");
    expect(issues.some((i) => i.code === "division.odd-teams")).toBe(false);
    expect(issues.some((i) => i.code === "debate.withdrawn-team")).toBe(false);
    const short = issues.filter((i) => i.code === "draw.withdrawn-team");
    expect(short.map((i) => i.round)).toEqual([1, 2, 3]);
    expect(
      short.every((i) => i.tab === "draw" && i.severity === "blocker" && i.divisionCode === "Open"),
    ).toBe(true);
    const first = s.debates.find(
      (d) => d.round === 1 && [d.governmentTeamId, d.oppositionTeamId].includes(s.teams[0].id),
    );
    const opponent = s.teams.find(
      (t) =>
        t.id ===
        (first?.governmentTeamId === s.teams[0].id
          ? first?.oppositionTeamId
          : first?.governmentTeamId),
    );
    const room = s.rooms.find((r) => r.id === first?.roomId);
    expect(short[0].message).toBe(
      `Round 1 in ${room?.name}: Open Team 1 (O01) has withdrawn; give ${opponent?.name} (${opponent?.code}) a new opponent or take the debate out of the draw.`,
    );
  });

  it("after a team joins a drawn division, reports the rounds it is missing from", () => {
    const s = clone(drawnSchedule({ open: 8, rooms: 4 }));
    s.teams.push(sampleTeam("Open", 9));
    const issues = readiness(s, "Open");
    expect(issues.some((i) => i.tab === "teams")).toBe(false);
    expect(texts(issues)).toEqual([
      "Open Team 9 (O09) is missing from round 1.",
      "Open Team 9 (O09) is missing from round 2.",
      "Open Team 9 (O09) is missing from round 3.",
    ]);
  });

  it("in per-round mode, sizes the judge pool against every room in use before the draw", () => {
    const build = (judges: number) =>
      buildSchedule({
        open: 8,
        novice: 4,
        rooms: 6,
        judges,
        judgesPerRoom: 2,
        panelMode: "per-round",
      });
    expect(readiness(build(5), "Open")).toContainEqual({
      code: "judges.too-few",
      message: "5 judges are listed; 6 rooms need at least one judge each.",
      tab: "judges",
      severity: "blocker",
    });
    expect(readiness(build(6), "Novice")).toContainEqual({
      code: "judges.short",
      message: "6 judges are listed; 6 rooms with 2 judges each need 12.",
      tab: "judges",
      severity: "warning",
    });
    expect(readiness(build(12), "Open").filter((i) => i.tab === "judges")).toEqual([]);
    const drawn = drawnSchedule({
      open: 8,
      rooms: 4,
      judges: 6,
      judgesPerRoom: 2,
      panelMode: "per-round",
    });
    expect(readiness(drawn, "Open")).toEqual([]);
  });

  it("blocks a room with more than five judges allocated", () => {
    const s = buildSchedule({ open: 4, rooms: 2, judges: 8, judgesPerRoom: 6 });
    expect(readiness(s, "Open")).toContainEqual(
      expect.objectContaining({
        code: "room.panel-too-big",
        message: "Room 1 has 6 judges allocated; panels allow at most five.",
        severity: "blocker",
      }),
    );
  });

  it("reports the debate count per round, and missing teams once a round is partly drawn", () => {
    const s = clone(drawnSchedule({ open: 8, rooms: 4 }));
    s.debates = s.debates.filter((d) => d.round !== 3 && !(d.round === 2 && d.id.endsWith("-d1")));
    const issues = readiness(s, "Open");
    expect(texts(issues)).toContain("Round 2 has 3 debates; expected 4.");
    expect(texts(issues)).toContain("Round 3 has 0 debates; expected 4.");
    expect(issues.filter((i) => i.code === "draw.missing-team").map((i) => i.round)).toEqual([
      2, 2,
    ]);
    expect(issues.filter((i) => i.round === 3)).toHaveLength(1);
  });

  it("adds the side rule only when every round is drawn, and never repeats a message", () => {
    const s = clone(drawnSchedule({ open: 8, rooms: 4 }));
    const team = s.teams[0];
    for (const debate of s.debates) {
      if (debate.round !== 3 && debate.oppositionTeamId === team.id) {
        [debate.governmentTeamId, debate.oppositionTeamId] = [
          debate.oppositionTeamId,
          debate.governmentTeamId,
        ];
      }
    }
    const issues = readiness(s, "Open");
    const sides = issues.filter(
      (i) => i.message === "Open Team 1 (O01) must debate on each side at least once.",
    );
    expect(sides).toHaveLength(1);
    s.debates = s.debates.filter((d) => d.round !== 3);
    expect(readiness(s, "Open").some((i) => i.code === "draw.sides-unbalanced")).toBe(false);
  });

  it("orders by tab, then round, then blockers before warnings", () => {
    const s = clone(drawnSchedule({ open: 8, rooms: 4 }));
    s.judges[0].status = "withdrawn";
    s.debates = s.debates.filter((d) => !(d.round === 3 && d.id.endsWith("-d4")));
    s.teams[0].school = "";
    const issues = readiness(s, "Open");
    const tabs = issues.map((i) => i.tab);
    expect(tabs).toEqual(
      [...tabs].sort(
        (a, b) =>
          ["teams", "judges", "rooms", "draw"].indexOf(a) -
          ["teams", "judges", "rooms", "draw"].indexOf(b),
      ),
    );
    const draw = issues.filter((i) => i.tab === "draw").map((i) => i.round ?? 0);
    expect(draw).toEqual([...draw].sort((a, b) => a - b));
    expect(issues[0].tab).toBe("teams");
    expect(issues[0].severity).toBe("blocker");
  });
});

describe("sortIssues and dedupeByMessage", () => {
  const issue = (partial: Partial<ScheduleIssue>): ScheduleIssue => ({
    code: "x",
    message: "m",
    tab: "draw",
    severity: "blocker",
    ...partial,
  });

  it("sorts stably", () => {
    const sorted = sortIssues([
      issue({ message: "d2 warning", round: 2, severity: "warning" }),
      issue({ message: "j", tab: "judges" }),
      issue({ message: "d1", round: 1 }),
      issue({ message: "t warning", tab: "teams", severity: "warning" }),
      issue({ message: "t blocker", tab: "teams" }),
      issue({ message: "d2 blocker", round: 2 }),
    ]);
    expect(sorted.map((i) => i.message)).toEqual([
      "t blocker",
      "t warning",
      "j",
      "d1",
      "d2 blocker",
      "d2 warning",
    ]);
  });

  it("keeps the first of each message", () => {
    const deduped = dedupeByMessage([
      issue({ message: "a", round: 1 }),
      issue({ message: "b" }),
      issue({ message: "a", round: 2 }),
    ]);
    expect(deduped).toEqual([issue({ message: "a", round: 1 }), issue({ message: "b" })]);
  });
});
