import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_ID_PREFIX,
  assignmentId,
  deriveAssignments,
  displayOf,
  identityOf,
  roleFor,
} from "@/domain/schedule";
import type { Assignment, AssignmentIdentity, Schedule } from "@/domain/types";
import { clone, drawnSchedule } from "../draw/build-schedule";

const base = drawnSchedule({ open: 8, rooms: 4, judgesPerRoom: 2 });
const ids = (assignments: Assignment[]) => assignments.map((a) => a.id).sort();
const firstDebate = (schedule: Schedule) => schedule.debates[0];
const forDebate = (assignments: Assignment[], debateId: string) =>
  assignments.filter((a) => a.identity.debateId === debateId);
const bump = (schedule: Schedule) => ({ ...schedule, revision: schedule.revision + 1 });

describe("assignmentId", () => {
  const identity: AssignmentIdentity = {
    debateId: "d1",
    divisionCode: "Open",
    round: 1,
    judgeId: "j1",
    governmentTeamId: "t1",
    oppositionTeamId: "t2",
    speakers: [
      { id: "s1", teamId: "t1", side: "government", position: 1 },
      { id: "s2", teamId: "t1", side: "government", position: 2 },
      { id: "s3", teamId: "t2", side: "opposition", position: 1 },
      { id: "s4", teamId: "t2", side: "opposition", position: 2 },
    ],
  };

  it("is 'asg_' plus 20 hex characters", () => {
    expect(assignmentId(identity, [], 1)).toMatch(/^asg_[0-9a-f]{20}$/);
  });

  it("does not depend on key order or on the order of previous ids", () => {
    const reordered = JSON.parse(
      JSON.stringify({
        speakers: identity.speakers,
        oppositionTeamId: "t2",
        governmentTeamId: "t1",
        judgeId: "j1",
        round: 1,
        divisionCode: "Open",
        debateId: "d1",
      }),
    ) as AssignmentIdentity;
    expect(assignmentId(reordered, ["asg_b", "asg_a"], 3)).toBe(
      assignmentId(identity, ["asg_a", "asg_b"], 3),
    );
  });

  it("changes with the previous ids and with the revision", () => {
    expect(assignmentId(identity, [], 1)).not.toBe(assignmentId(identity, ["asg_x"], 1));
    expect(assignmentId(identity, [], 1)).not.toBe(assignmentId(identity, [], 2));
  });
});

describe("identityOf and displayOf", () => {
  it("lists Government then Opposition debaters with their roles", () => {
    const debate = firstDebate(base);
    const identity = identityOf(base, debate, debate.judgeIds[0]);
    expect(identity.speakers.map((s) => `${s.side}:${s.position}`)).toEqual([
      "government:1",
      "government:2",
      "opposition:1",
      "opposition:2",
    ]);
    const display = displayOf(base, debate, debate.judgeIds[0]);
    expect(display.speakers.map((s) => s.role)).toEqual(["pm", "gm", "lo", "om"]);
    expect(display.roundFormat).toBe("prepared");
    expect(display.sidesDecided).toBe("in-advance");
    expect(display.roomName).toMatch(/^Room \d$/);
    expect(display.judgeName).toBe("Judge 01");
    expect(display.government.teamId).toBe(debate.governmentTeamId);
    expect(roleFor("opposition", 2)).toBe("om");
  });

  it("throws on a reference that is not in the schedule", () => {
    const debate = { ...firstDebate(base), governmentTeamId: "team-missing" };
    expect(() => identityOf(base, debate, debate.judgeIds[0])).toThrow(
      "Government team team-missing is not in the schedule.",
    );
    expect(() => displayOf(base, firstDebate(base), "judge-99")).toThrow(
      "Judge judge-99 is not in the schedule.",
    );
  });
});

describe("deriveAssignments", () => {
  it("makes one live assignment per judge seat, with unique ids", () => {
    const { assignments, retired, skipped } = deriveAssignments(base);
    const seats = base.debates.reduce((sum, debate) => sum + debate.judgeIds.length, 0);
    expect(assignments).toHaveLength(seats);
    expect(new Set(ids(assignments)).size).toBe(seats);
    expect(
      assignments.every(
        (a) => a.id.startsWith(ASSIGNMENT_ID_PREFIX) && a.scheduleRevision === 1 && !a.retiredAt,
      ),
    ).toBe(true);
    expect(retired).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("keeps every id across cosmetic changes and refreshes the display", () => {
    const original = deriveAssignments(base).assignments;
    const edited = clone(bump(base));
    edited.debates[0].motion = "This House would move the debate online.";
    edited.rooms[0].name = "Library";
    edited.teams[0].speakers[0].name = "Debater O01 Renamed";
    edited.teams[0].name = "Open Team One";
    edited.judges[0].name = "Judge One";
    const next = deriveAssignments(edited, original);
    expect(ids(next.assignments)).toEqual(ids(original));
    expect(next.retired).toEqual([]);
    expect(next.assignments.every((a) => a.scheduleRevision === 2)).toBe(true);
    const refreshed = next.assignments.find(
      (a) =>
        a.identity.debateId === edited.debates[0].id && a.identity.judgeId === edited.judges[0].id,
    );
    expect(refreshed?.display.motion).toBe("This House would move the debate online.");
    expect(refreshed?.display.judgeName).toBe("Judge One");
    expect(refreshed?.display.roomName).toBe("Library");
    expect(
      next.assignments.some((a) =>
        a.display.speakers.some((s) => s.name === "Debater O01 Renamed"),
      ),
    ).toBe(true);
  });

  it("retires the slot when a debater is replaced", () => {
    const original = deriveAssignments(base).assignments;
    const edited = clone(bump(base));
    const team = edited.teams.find((t) => t.id === firstDebate(edited).governmentTeamId);
    if (!team) throw new Error("fixture");
    team.speakers[1] = { id: "sub-1", name: "Debater Substitute", position: 2 };
    const next = deriveAssignments(edited, original);
    const affected = edited.debates.filter(
      (d) => d.governmentTeamId === team.id || d.oppositionTeamId === team.id,
    );
    expect(next.retired).toHaveLength(affected.length * 2);
    expect(next.retired.every((r) => r.reason === "matchup-changed" && r.successorId)).toBe(true);
    for (const debate of affected) {
      const before = forDebate(original, debate.id).map((a) => a.id);
      const after = forDebate(next.assignments, debate.id);
      expect(after.every((a) => !before.includes(a.id))).toBe(true);
    }
    expect(
      next.assignments
        .filter((a) => !affected.some((d) => d.id === a.identity.debateId))
        .map((a) => a.id)
        .sort(),
    ).toEqual(
      original
        .filter((a) => !affected.some((d) => d.id === a.identity.debateId))
        .map((a) => a.id)
        .sort(),
    );
  });

  it("retires a removed judge's slot without a successor and issues a new id for the new judge", () => {
    const original = deriveAssignments(base).assignments;
    const edited = clone(bump(base));
    edited.settings.panelMode = "per-round";
    const debate = firstDebate(edited);
    const [gone] = debate.judgeIds;
    const spare = edited.judges.find((j) => !debate.judgeIds.includes(j.id));
    if (!spare) throw new Error("fixture");
    debate.judgeIds[0] = spare.id;
    const next = deriveAssignments(edited, original);
    const removed = original.find(
      (a) => a.identity.debateId === debate.id && a.identity.judgeId === gone,
    );
    expect(next.retired).toEqual([{ id: removed?.id, successorId: null, reason: "slot-removed" }]);
    const added = next.assignments.find(
      (a) => a.identity.debateId === debate.id && a.identity.judgeId === spare.id,
    );
    expect(added).toBeDefined();
    expect(original.some((a) => a.id === added?.id)).toBe(false);
  });

  it("retires a debate's slots on a side swap and on an opponent change", () => {
    const original = deriveAssignments(base).assignments;
    const swapped = clone(bump(base));
    const debate = firstDebate(swapped);
    [debate.governmentTeamId, debate.oppositionTeamId] = [
      debate.oppositionTeamId,
      debate.governmentTeamId,
    ];
    const afterSwap = deriveAssignments(swapped, original);
    expect(afterSwap.retired.map((r) => r.id).sort()).toEqual(
      forDebate(original, debate.id)
        .map((a) => a.id)
        .sort(),
    );
    expect(afterSwap.assignments).toHaveLength(original.length);

    const changed = clone(bump(base));
    const [first, second] = changed.debates.filter((d) => d.round === 1);
    [first.oppositionTeamId, second.oppositionTeamId] = [
      second.oppositionTeamId,
      first.oppositionTeamId,
    ];
    const afterChange = deriveAssignments(changed, original);
    expect(afterChange.retired.map((r) => r.id).sort()).toEqual(
      [...forDebate(original, first.id), ...forDebate(original, second.id)].map((a) => a.id).sort(),
    );
    for (const slot of afterChange.retired) {
      expect(afterChange.assignments.some((a) => a.id === slot.successorId)).toBe(true);
    }
  });

  it("revert does not resurrect: undoing an edit gives a third id, not the first one back", () => {
    const original = deriveAssignments(base).assignments;
    const edited = clone(bump(base));
    const debate = firstDebate(edited);
    [debate.governmentTeamId, debate.oppositionTeamId] = [
      debate.oppositionTeamId,
      debate.governmentTeamId,
    ];
    const second = deriveAssignments(edited, original);
    const retiredNow = original.map((a) =>
      second.retired.some((r) => r.id === a.id) ? { ...a, retiredAt: "2026-09-16T10:00:00Z" } : a,
    );
    const history = [
      ...retiredNow,
      ...second.assignments.filter((a) => !original.some((o) => o.id === a.id)),
    ];

    const reverted = { ...clone(base), revision: 3 };
    const third = deriveAssignments(reverted, history);
    const firstIds = forDebate(original, debate.id).map((a) => a.id);
    const thirdIds = forDebate(third.assignments, debate.id).map((a) => a.id);
    expect(thirdIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(third.retired.map((r) => r.id).sort()).toEqual(
      forDebate(second.assignments, debate.id)
        .map((a) => a.id)
        .sort(),
    );
    expect(
      third.assignments
        .filter((a) => a.identity.debateId !== debate.id)
        .map((a) => a.id)
        .sort(),
    ).toEqual(
      original
        .filter((a) => a.identity.debateId !== debate.id)
        .map((a) => a.id)
        .sort(),
    );
  });

  it("is idempotent: deriving again with its own output changes nothing", () => {
    const first = deriveAssignments(base);
    const again = deriveAssignments(base, first.assignments);
    expect(again.assignments).toEqual(first.assignments);
    expect(again.retired).toEqual([]);
  });

  it("skips slots with broken references instead of throwing", () => {
    const broken = clone(base);
    broken.debates[0].roomId = "room-99";
    const result = deriveAssignments(broken);
    expect(result.skipped).toHaveLength(broken.debates[0].judgeIds.length);
    expect(result.skipped[0]).toEqual({
      debateId: broken.debates[0].id,
      judgeId: broken.debates[0].judgeIds[0],
      reason: "Room room-99 is not in the schedule.",
      previousId: null,
    });
  });

  it("leaves a skipped slot as it was: not live, not retired, and named by its previous id", () => {
    const original = deriveAssignments(base).assignments;
    const broken = clone(bump(base));
    broken.debates[0].roomId = "room-99";
    const result = deriveAssignments(broken, original);
    const before = forDebate(original, broken.debates[0].id)
      .map((a) => a.id)
      .sort();
    expect(result.skipped.map((slot) => slot.previousId).sort()).toEqual(before);
    expect(result.retired).toEqual([]);
    expect(result.assignments.some((a) => a.identity.debateId === broken.debates[0].id)).toBe(
      false,
    );
    // The room is display-only, so repairing it brings the same ids back.
    const repaired = { ...clone(base), revision: 3 };
    expect(ids(deriveAssignments(repaired, original).assignments)).toEqual(ids(original));
  });
});
