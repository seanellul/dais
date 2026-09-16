import { describe, expect, it } from "vitest";
import { generateSample } from "@/domain/sample/generate";
import {
  SAMPLE_FAMILY_NAMES,
  SAMPLE_GIVEN_NAMES,
  SAMPLE_MOTIONS,
  SAMPLE_SCHOOLS,
} from "@/domain/sample/names";
import { DEFAULT_SETTINGS } from "@/domain/settings";

describe("generateSample", () => {
  const roster = generateSample({ seed: "demo-2026" });

  it("is deterministic from the seed", () => {
    expect(generateSample({ seed: "demo-2026" })).toEqual(roster);
    expect(generateSample({ seed: "demo-2027" })).not.toEqual(roster);
    expect(roster.seed).toBe("demo-2026");
  });

  it("builds 12 Open and 8 Novice teams with codes and two debaters each", () => {
    expect(roster.teams).toHaveLength(20);
    const open = roster.teams.filter((team) => team.divisionCode === "Open");
    const novice = roster.teams.filter((team) => team.divisionCode === "Novice");
    expect(open.map((team) => team.code)).toEqual(
      Array.from({ length: 12 }, (_, i) => `O${String(i + 1).padStart(2, "0")}`),
    );
    expect(novice.map((team) => team.code)).toEqual(
      Array.from({ length: 8 }, (_, i) => `N${String(i + 1).padStart(2, "0")}`),
    );
    for (const team of roster.teams) {
      expect(team.speakers.map((speaker) => speaker.position)).toEqual([1, 2]);
      expect(team.status).toBe("active");
      expect(team.school.length).toBeGreaterThan(0);
      expect(team.name.length).toBeGreaterThan(0);
    }
  });

  it("names every person once across debaters and judges", () => {
    const names = [
      ...roster.teams.flatMap((team) => team.speakers.map((speaker) => speaker.name)),
      ...roster.judges.map((judge) => judge.name),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(40 + 30);
  });

  it("gives every team, debater, judge and room a unique id", () => {
    const ids = [
      ...roster.teams.map((team) => team.id),
      ...roster.teams.flatMap((team) => team.speakers.map((speaker) => speaker.id)),
      ...roster.judges.map((judge) => judge.id),
      ...roster.rooms.map((room) => room.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps team names unique within a division", () => {
    for (const division of ["Open", "Novice"]) {
      const keys = roster.teams
        .filter((team) => team.divisionCode === division)
        .map((team) => `${team.school}|${team.name}`.toLowerCase());
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("creates rooms in order and the tournament default of judges per room", () => {
    expect(DEFAULT_SETTINGS.judgesPerRoom).toBe(3);
    expect(roster.rooms.map((room) => [room.name, room.sortOrder])).toEqual(
      Array.from({ length: 10 }, (_, i) => [`Room ${i + 1}`, i + 1]),
    );
    expect(roster.judges).toHaveLength(30);
    for (const room of roster.rooms) {
      expect(roster.judges.filter((judge) => judge.homeRoomId === room.id)).toHaveLength(3);
    }
  });

  it("honours custom sizes and division codes", () => {
    const small = generateSample({
      seed: 1,
      open: 4,
      novice: 2,
      rooms: 3,
      judgesPerRoom: 2,
      openCode: "Senior",
      noviceCode: "Junior",
    });
    expect(small.teams.map((team) => team.code)).toEqual([
      "S01",
      "S02",
      "S03",
      "S04",
      "J01",
      "J02",
    ]);
    expect(small.judges).toHaveLength(6);
  });

  it("keeps codes and ids unique when two divisions start with the same letter", () => {
    const roster = generateSample({
      seed: 3,
      open: 3,
      novice: 2,
      rooms: 2,
      openCode: "Senior",
      noviceCode: "Sophomore",
    });
    expect(roster.teams.map((team) => [team.code, team.divisionCode])).toEqual([
      ["S01", "Senior"],
      ["S02", "Senior"],
      ["S03", "Senior"],
      ["S04", "Sophomore"],
      ["S05", "Sophomore"],
    ]);
    const ids = [
      ...roster.teams.map((team) => team.id),
      ...roster.teams.flatMap((team) => team.speakers.map((speaker) => speaker.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels extra teams from the same school A, B, C", () => {
    const big = generateSample({ seed: 2, open: 30, novice: 0, rooms: 1 });
    const names = big.teams.map((team) => team.name);
    expect(new Set(names).size).toBe(30);
    expect(names.some((name) => / B$/.test(name))).toBe(true);
  });
});

describe("name banks", () => {
  it("hold enough invented names for a full tournament", () => {
    expect(SAMPLE_SCHOOLS.length).toBeGreaterThanOrEqual(20);
    expect(SAMPLE_GIVEN_NAMES.length).toBeGreaterThanOrEqual(40);
    expect(SAMPLE_FAMILY_NAMES.length).toBeGreaterThanOrEqual(40);
    expect(SAMPLE_MOTIONS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(SAMPLE_SCHOOLS.map(([school]) => school)).size).toBe(SAMPLE_SCHOOLS.length);
  });
});
