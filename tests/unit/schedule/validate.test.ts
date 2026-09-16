import { describe, expect, it } from "vitest";
import {
  hasBlockers,
  scheduleIssues,
  validateSchedule,
  type ScheduleIssue,
} from "@/domain/schedule";
import type { Schedule } from "@/domain/types";
import { clone, drawnSchedule, sampleTeam } from "../draw/build-schedule";

/** A drawn Open division: 8 teams, 4 rooms, 2 fixed judges per room. */
const base = drawnSchedule({ open: 8, rooms: 4, judgesPerRoom: 2 });

function messages(schedule: Schedule, options = {}): string[] {
  return scheduleIssues(schedule, options).map((issue) => issue.message);
}

function only(schedule: Schedule, options = {}): ScheduleIssue {
  const issues = scheduleIssues(schedule, options);
  expect(issues).toHaveLength(1);
  return issues[0];
}

const round1 = (schedule: Schedule) => schedule.debates.filter((debate) => debate.round === 1);

describe("validateSchedule: a sound draw", () => {
  it("passes in draft and complete mode", () => {
    expect(validateSchedule(base)).toEqual({ ok: true });
    expect(validateSchedule(base, { requireComplete: true })).toEqual({ ok: true });
    expect(validateSchedule(base, { requireComplete: true, divisionCode: "Open" })).toEqual({
      ok: true,
    });
  });

  it("allows an incomplete draft but not an incomplete publish", () => {
    const draft = clone(base);
    draft.debates = draft.debates.filter((debate) => debate.round !== 3);
    expect(validateSchedule(draft)).toEqual({ ok: true });
    const result = validateSchedule(draft, { requireComplete: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(8);
    expect(result.issues[0].message).toBe("Open round 3 is missing team Open Team 1 (O01).");
    expect(result.issues[0]).toMatchObject({
      code: "draw.missing-team",
      tab: "draw",
      round: 3,
      divisionCode: "Open",
      severity: "blocker",
    });
  });
});

describe("validateSchedule: identity rules", () => {
  it("Team IDs must be unique.", () => {
    const s = clone(base);
    s.teams[1].id = s.teams[0].id;
    expect(messages(s)).toContain("Team IDs must be unique.");
  });

  it("Judge IDs must be unique.", () => {
    const s = clone(base);
    s.judges[1].id = s.judges[0].id;
    expect(messages(s)).toContain("Judge IDs must be unique.");
  });

  it("Room IDs must be unique.", () => {
    const s = clone(base);
    s.rooms[1].id = s.rooms[0].id;
    expect(messages(s)).toContain("Room IDs must be unique.");
  });

  it("Debate IDs must be unique.", () => {
    const s = clone(base);
    s.debates[1].id = s.debates[0].id;
    expect(only(s).message).toBe("Debate IDs must be unique.");
  });

  it("Debater IDs must be unique.", () => {
    const s = clone(base);
    s.teams[1].speakers[0].id = s.teams[0].speakers[0].id;
    expect(only(s).message).toBe("Debater IDs must be unique.");
  });

  it("Team codes must be unique.", () => {
    const s = clone(base);
    s.teams[1].code = s.teams[0].code.toLowerCase();
    expect(only(s).message).toBe("Team codes must be unique.");
  });

  it("Team names within each division must be unique.", () => {
    const s = clone(base);
    s.teams[1].name = ` ${s.teams[0].name.toUpperCase()} `;
    expect(only(s).message).toBe("Team names within each division must be unique.");
  });

  it("allows the same team name in two divisions", () => {
    const s = clone(base);
    s.teams.push({ ...sampleTeam("Novice", 1), name: s.teams[0].name });
    expect(validateSchedule(s)).toEqual({ ok: true });
  });
});

describe("validateSchedule: team, judge and room shape", () => {
  it("Every team needs an ID, a code, a name, a school and a division.", () => {
    const s = clone(base);
    s.teams[0].school = "  ";
    expect(only(s)).toMatchObject({
      code: "team.incomplete",
      message: "Every team needs an ID, a code, a name, a school and a division.",
      tab: "teams",
      divisionCode: "Open",
    });
  });

  it("Team … is in division …, which is not in the tournament settings.", () => {
    const s = clone(base);
    s.teams[0].divisionCode = "Intermediate";
    expect(messages(s)).toContain(
      'Team O01 is in division "Intermediate", which is not in the tournament settings.',
    );
  });

  it("Team … needs two named debaters, one in position 1 and one in position 2.", () => {
    const s = clone(base);
    s.teams[0].speakers[1].position = 1;
    expect(only(s).message).toBe(
      "Team O01 needs two named debaters, one in position 1 and one in position 2.",
    );
    s.teams[0].speakers = [];
    expect(only(s).message).toBe(
      "Team O01 needs two named debaters, one in position 1 and one in position 2.",
    );
  });

  it("Team … has only one debater. (warning)", () => {
    const s = clone(base);
    s.teams[0].speakers = [s.teams[0].speakers[0]];
    expect(only(s)).toMatchObject({
      code: "team.one-debater",
      message: "Team O01 has only one debater.",
      severity: "warning",
    });
    expect(hasBlockers(scheduleIssues(s))).toBe(false);
  });

  it("Every judge needs an ID and a name.", () => {
    const s = clone(base);
    s.judges[0].name = "";
    expect(only(s)).toMatchObject({
      message: "Every judge needs an ID and a name.",
      tab: "judges",
    });
  });

  it("Judge … is allocated to an unknown room.", () => {
    const s = clone(base);
    s.judges[0].homeRoomId = "room-99";
    expect(messages(s)).toContain("Judge Judge 01 is allocated to an unknown room.");
  });

  it("Every room needs an ID and a name.", () => {
    const s = clone(base);
    s.rooms[0].name = " ";
    expect(only(s)).toMatchObject({ message: "Every room needs an ID and a name.", tab: "rooms" });
  });
});

describe("validateSchedule: debate rules", () => {
  it("Every debate needs an ID, a division from the tournament settings and a motion, which may be left blank.", () => {
    const s = clone(base);
    s.debates[0].divisionCode = "";
    expect(only(s)).toMatchObject({
      code: "debate.incomplete",
      message:
        "Every debate needs an ID, a division from the tournament settings and a motion, which may be left blank.",
      tab: "draw",
      divisionCode: undefined,
    });
    const blank = clone(base);
    blank.debates[0].motion = "";
    expect(validateSchedule(blank)).toEqual({ ok: true });
  });

  it("Round … is not one of the tournament's rounds; add it in Settings or remove its debates.", () => {
    const s = clone(base);
    s.debates[0].round = 9;
    expect(only(s)).toMatchObject({
      code: "debate.unknown-round",
      message:
        "Round 9 is not one of the tournament's rounds; add it in Settings or remove its debates.",
      tab: "draw",
      round: 9,
      divisionCode: "Open",
    });
  });

  it("Round …: … v … is in a room that no longer exists; pick a room in the Draw.", () => {
    const s = clone(base);
    s.settings.panelMode = "per-round";
    const debate = s.debates[0];
    debate.roomId = "room-99";
    const code = (id: string) => s.teams.find((t) => t.id === id)?.code;
    expect(only(s)).toMatchObject({
      code: "debate.unknown-room",
      message: `Round 1: ${code(debate.governmentTeamId)} v ${code(debate.oppositionTeamId)} is in a room that no longer exists; pick a room in the Draw.`,
      tab: "draw",
    });
  });

  it("… references invalid teams.", () => {
    const s = clone(base);
    const debate = round1(s)[0];
    debate.oppositionTeamId = debate.governmentTeamId;
    const room = s.rooms.find((r) => r.id === debate.roomId);
    expect(messages(s)).toContain(`Round 1 in ${room?.name} references invalid teams.`);
  });

  it("… uses a team from another division.", () => {
    const s = clone(base);
    const debate = round1(s)[0];
    const team = s.teams.find((t) => t.id === debate.governmentTeamId);
    if (team) team.divisionCode = "Novice";
    const room = s.rooms.find((r) => r.id === debate.roomId);
    expect(messages(s)).toContain(`Round 1 in ${room?.name} uses a team from another division.`);
  });

  it("Team … has withdrawn but is still in the draw for round …. (warning)", () => {
    const s = clone(base);
    s.teams[0].status = "withdrawn";
    const issues = scheduleIssues(s);
    expect(issues.map((i) => i.message)).toContain(
      "Team O01 has withdrawn but is still in the draw for round 1.",
    );
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("Team … appears more than once in round ….", () => {
    const s = clone(base);
    const [first, second] = round1(s);
    second.governmentTeamId = first.governmentTeamId;
    const code = s.teams.find((t) => t.id === first.governmentTeamId)?.code;
    expect(messages(s)).toContain(`Team ${code} appears more than once in round 1.`);
  });

  it("Teams … and … meet more than once.", () => {
    const s = clone(base);
    const first = round1(s)[0];
    const later = s.debates.find(
      (d) =>
        d.round === 2 &&
        ![first.governmentTeamId, first.oppositionTeamId].includes(d.governmentTeamId) &&
        ![first.governmentTeamId, first.oppositionTeamId].includes(d.oppositionTeamId),
    );
    if (!later) throw new Error("fixture");
    const swapOut = s.debates.find(
      (d) =>
        d.round === 2 &&
        d.id !== later.id &&
        [first.governmentTeamId, first.oppositionTeamId].includes(d.governmentTeamId),
    );
    if (!swapOut) throw new Error("fixture");
    // Move round-1 opponents into the same round-2 debate; the other debate loses a team so it stays unique per round.
    swapOut.governmentTeamId = later.governmentTeamId;
    later.governmentTeamId = first.governmentTeamId;
    later.oppositionTeamId = first.oppositionTeamId;
    const g = s.teams.find((t) => t.id === first.governmentTeamId)?.code;
    const o = s.teams.find((t) => t.id === first.oppositionTeamId)?.code;
    expect(messages(s)).toContain(`Teams ${g} and ${o} meet more than once.`);
  });

  it("… needs one to five judges.", () => {
    const s = clone(base);
    round1(s)[0].judgeIds = [];
    expect(only(s)).toMatchObject({
      code: "debate.panel-size",
      message: "Round 1 in Room 1 needs one to five judges.",
      tab: "judges",
      round: 1,
    });
    round1(s)[0].judgeIds = ["a", "b", "c", "d", "e", "f"];
    expect(only(s).message).toBe("Round 1 in Room 1 needs one to five judges.");
  });

  it("… lists the same judge twice.", () => {
    const s = clone(base);
    const debate = round1(s)[0];
    debate.judgeIds[1] = debate.judgeIds[0];
    expect(only(s).message).toBe("Round 1 in Room 1 lists the same judge twice.");
  });

  it("… references an unknown judge.", () => {
    const s = clone(base);
    round1(s)[0].judgeIds[0] = "judge-99";
    expect(only(s).message).toBe("Round 1 in Room 1 references an unknown judge.");
  });

  it("… has withdrawn but is still on a panel in round …. (warning)", () => {
    const s = clone(base);
    s.judges[0].status = "withdrawn";
    const issues = scheduleIssues(s);
    expect(issues.map((i) => i.message)).toContain(
      "Judge 01 has withdrawn but is still on a panel in round 1.",
    );
    expect(hasBlockers(issues)).toBe(false);
  });

  it("… sits in more than one room. (fixed-room mode only)", () => {
    const s = clone(base);
    const first = s.debates.find((d) => d.round === 2 && d.roomId === "room-01");
    const second = s.debates.find((d) => d.round === 2 && d.roomId === "room-02");
    if (!first || !second) throw new Error("fixture");
    [first.judgeIds, second.judgeIds] = [second.judgeIds, first.judgeIds];
    const message =
      "Judge 01 sits in more than one room. Judges stay in their allocated room for all rounds; change the room allocation in Judges.";
    expect(messages(s)).toContain(message);
    expect(scheduleIssues(s).find((i) => i.message === message)).toMatchObject({
      code: "judge.room-changed",
      tab: "judges",
      divisionCode: undefined,
    });
    s.settings.panelMode = "per-round";
    expect(validateSchedule(s)).toEqual({ ok: true });
  });

  it("… is on two panels in round ….", () => {
    const s = clone(base);
    s.settings.panelMode = "per-round";
    const [first, second] = round1(s);
    second.judgeIds[0] = first.judgeIds[0];
    expect(only(s)).toMatchObject({
      code: "round.judge-double-booked",
      message: "Judge 01 is on two panels in round 1.",
      tab: "draw",
      round: 1,
    });
  });

  it("… is booked twice in round ….", () => {
    const s = clone(base);
    s.settings.panelMode = "per-round";
    const [first, second] = round1(s);
    second.roomId = first.roomId;
    expect(only(s)).toMatchObject({
      code: "round.room-double-booked",
      message: "Room 1 is booked twice in round 1.",
      tab: "draw",
      round: 1,
      divisionCode: "Open",
    });
  });
});

describe("validateSchedule: complete mode", () => {
  it("… round … is missing team ….", () => {
    const s = clone(base);
    s.debates = s.debates.filter((d) => d.id !== round1(s)[0].id);
    const issues = scheduleIssues(s, { requireComplete: true }).filter(
      (i) => i.code === "draw.missing-team",
    );
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/^Open round 1 is missing team Open Team \d \(O0\d\)\.$/),
      expect.stringMatching(/^Open round 1 is missing team Open Team \d \(O0\d\)\.$/),
    ]);
    expect(issues.every((i) => i.tab === "draw" && i.round === 1 && i.severity === "blocker")).toBe(
      true,
    );
  });

  it("… must debate on each side at least once.", () => {
    const s = clone(base);
    const team = s.teams[0];
    for (const debate of s.debates) {
      if (debate.round === 3) continue;
      if (debate.oppositionTeamId === team.id)
        [debate.governmentTeamId, debate.oppositionTeamId] = [
          debate.oppositionTeamId,
          debate.governmentTeamId,
        ];
    }
    expect(validateSchedule(s)).toEqual({ ok: true });
    const issues = scheduleIssues(s, { requireComplete: true });
    expect(issues.map((i) => i.message)).toContain(
      "Open Team 1 (O01) must debate on each side at least once.",
    );
    expect(issues.every((i) => i.code === "draw.sides-unbalanced" && i.tab === "draw")).toBe(true);
  });

  it("skips the side rule when fewer than two rounds have sides decided in advance", () => {
    const s = clone(base);
    s.settings.rounds = s.settings.rounds.map((round) => ({ ...round, sidesDecided: "in-room" }));
    const team = s.teams[0];
    for (const debate of s.debates) {
      if (debate.oppositionTeamId === team.id)
        [debate.governmentTeamId, debate.oppositionTeamId] = [
          debate.oppositionTeamId,
          debate.governmentTeamId,
        ];
    }
    expect(validateSchedule(s, { requireComplete: true })).toEqual({ ok: true });
  });

  it("checks only the named division and keeps tournament-wide issues", () => {
    const s = clone(base);
    s.teams.push(sampleTeam("Novice", 1));
    s.judges[0].name = "";
    const open = scheduleIssues(s, { requireComplete: true, divisionCode: "Open" });
    expect(open.map((i) => i.message)).toEqual(["Every judge needs an ID and a name."]);
    const novice = scheduleIssues(s, { requireComplete: true, divisionCode: "Novice" });
    expect(novice.map((i) => i.message)).toContain(
      "Novice round 1 is missing team Novice Team 1 (N01).",
    );
  });
});
