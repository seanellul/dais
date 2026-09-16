import { describe, expect, it } from "vitest";
import {
  affectedDivisions,
  deriveAssignments,
  rosterProjection,
  scoredSlotsAtRisk,
} from "@/domain/schedule";
import type { Schedule } from "@/domain/types";
import { clone, drawnSchedule, sampleJudge } from "../draw/build-schedule";

const base = drawnSchedule({ open: 8, novice: 4, rooms: 6, judgesPerRoom: 2 });
const snapshot = (schedule: Schedule, previous = deriveAssignments(base).assignments) => ({
  schedule,
  assignments: deriveAssignments(schedule, previous).assignments,
});

describe("affectedDivisions", () => {
  it("is empty when nothing changed", () => {
    expect(affectedDivisions(snapshot(base), snapshot(base))).toEqual([]);
  });

  it("ignores an unused room, an unused judge and a motion", () => {
    const edited = clone(base);
    edited.revision += 1;
    edited.rooms.push({ id: "room-spare", name: "Spare Room", sortOrder: 99 });
    edited.judges.push(sampleJudge(99));
    edited.debates[0].motion = "This House believes the draw is fair.";
    expect(affectedDivisions(snapshot(base), snapshot(edited))).toEqual([]);
  });

  it("names the division whose roster changed", () => {
    const renamed = clone(base);
    renamed.teams.find((t) => t.divisionCode === "Novice")!.speakers[0].name = "Debater Renamed";
    expect(affectedDivisions(snapshot(base), snapshot(renamed))).toEqual(["Novice"]);
    const reseeded = clone(base);
    reseeded.teams[0].seed = 42;
    expect(affectedDivisions(snapshot(base), snapshot(reseeded))).toEqual(["Open"]);
  });

  it("names only the division whose draw changed", () => {
    const edited = clone(base);
    edited.revision += 1;
    const debate = edited.debates.find((d) => d.divisionCode === "Novice")!;
    [debate.governmentTeamId, debate.oppositionTeamId] = [
      debate.oppositionTeamId,
      debate.governmentTeamId,
    ];
    expect(affectedDivisions(snapshot(base), snapshot(edited))).toEqual(["Novice"]);
  });

  it("projects the roster in a stable order with the scoring fields only", () => {
    const roster = rosterProjection(base, "Novice");
    expect(roster.map((entry) => entry.id)).toEqual([...roster.map((entry) => entry.id)].sort());
    expect(roster[0]).toEqual({
      id: "team-N01",
      code: "N01",
      name: "Novice Team 1",
      school: "Sample School 1",
      seed: 1,
      speakers: [
        { id: "N01-1", name: "Debater N01 One" },
        { id: "N01-2", name: "Debater N01 Two" },
      ],
    });
  });
});

describe("scoredSlotsAtRisk", () => {
  it("reports the retired slots that already hold a sheet", () => {
    const original = deriveAssignments(base).assignments;
    const edited = clone(base);
    edited.revision += 1;
    const debate = edited.debates[0];
    [debate.governmentTeamId, debate.oppositionTeamId] = [
      debate.oppositionTeamId,
      debate.governmentTeamId,
    ];
    const { retired } = deriveAssignments(edited, original);
    expect(retired).toHaveLength(2);
    const scored = new Set([retired[0].id, "asg_somewhere_else"]);
    expect(scoredSlotsAtRisk(retired, scored)).toEqual([retired[0]]);
    expect(scoredSlotsAtRisk(retired, new Set())).toEqual([]);
  });
});
