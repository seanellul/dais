import { describe, expect, it } from "vitest";
import { findTies, rankEq, tiedWith } from "@/domain/scoring";

describe("rankEq", () => {
  it("ranks descending with shared ranks and gaps after a tie", () => {
    expect(rankEq([100, 80, 80, 50])).toEqual([1, 2, 2, 4]);
    expect(rankEq([50, 50, 50])).toEqual([1, 1, 1]);
    expect(rankEq([1, 2, 3])).toEqual([3, 2, 1]);
  });

  it("leaves a null entry unranked without affecting the others", () => {
    expect(rankEq([60, null, 50])).toEqual([1, null, 2]);
    expect(rankEq([Number.NaN, 5])).toEqual([null, 1]);
    expect(rankEq([])).toEqual([]);
  });

  it("ties totals that are equal to 15 significant digits, whatever order they were summed in", () => {
    // 80 + 80⅓ + 80⅓ and 80⅓ + 80⅓ + 80 are the same total but one unit
    // apart in doubles. Exact comparison would rank them 1 and 2.
    const third = 241 / 3;
    const a = 80 + third + third;
    const b = third + third + 80;
    expect(a).not.toBe(b);
    expect(rankEq([a, b, 200])).toEqual([1, 1, 3]);
    expect(rankEq([300, b, a])).toEqual([1, 2, 2]);
  });
});

describe("findTies and tiedWith", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const ranks = [1, 1, 3, null, 3];

  it("lists every shared rank, lowest first", () => {
    expect(findTies(ids, ranks)).toEqual([
      { rank: 1, ids: ["a", "b"] },
      { rank: 3, ids: ["c", "e"] },
    ]);
  });

  it("names the others sharing an id's rank", () => {
    expect(tiedWith("a", ids, ranks)).toEqual(["b"]);
    expect(tiedWith("e", ids, ranks)).toEqual(["c"]);
    expect(tiedWith("d", ids, ranks)).toEqual([]);
    expect(tiedWith("zz", ids, ranks)).toEqual([]);
  });
});
