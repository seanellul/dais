/**
 * Ranking with Excel's RANK.EQ semantics, descending: the rank of a value is
 * 1 + the number of values strictly greater than it. Equal values share a rank
 * and the ranks after a tie have a gap (100, 80, 80, 50 → 1, 2, 2, 4).
 *
 * Two totals count as equal when they agree to 15 significant digits. A total
 * is a sum of round averages, and the same fractions summed in a different
 * round order can differ in the last binary digit: 80 + 80⅓ + 80⅓ and
 * 80⅓ + 80⅓ + 80 are one unit apart in doubles. Without the rounding those
 * two debaters would be ranked apart and no tie would be flagged.
 */

import { excelRounded } from "./lop";

const isRankable = (value: number | null): value is number =>
  value !== null && Number.isFinite(value);

/** The value a total is ranked on: `null` for no total, else 15 significant digits. */
function rankKey(value: number | null): number | null {
  return isRankable(value) ? excelRounded(value) : null;
}

/**
 * Rank a list of totals. A `null` (or non-finite) entry has no rank and does
 * not affect the others, which is how a debater who can't be scored yet is
 * kept out of the ranking without unranking the rest of the division.
 */
export function rankEq(values: (number | null)[]): (number | null)[] {
  const keys = values.map(rankKey);
  const sorted = keys.filter(isRankable).sort((a, b) => b - a);
  const rankOf = new Map<number, number>();
  sorted.forEach((key, index) => {
    // The first index of a key in descending order equals the count of
    // strictly greater keys, which is exactly RANK.EQ's definition.
    if (!rankOf.has(key)) rankOf.set(key, index + 1);
  });
  return keys.map((key) => (key === null ? null : (rankOf.get(key) ?? null)));
}

export interface RankGroup {
  rank: number;
  ids: string[];
}

/** Every rank shared by two or more ids, lowest rank first. */
export function findTies(ids: string[], ranks: (number | null)[]): RankGroup[] {
  const groups = new Map<number, string[]>();
  ids.forEach((id, index) => {
    const rank = ranks[index];
    if (rank === null || rank === undefined) return;
    const group = groups.get(rank) ?? [];
    group.push(id);
    groups.set(rank, group);
  });
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([rank, members]) => ({ rank, ids: members }));
}

/** The other ids that share this id's rank (empty when it has no rank or no tie). */
export function tiedWith(id: string, ids: string[], ranks: (number | null)[]): string[] {
  const index = ids.indexOf(id);
  const rank = index === -1 ? null : ranks[index];
  if (rank === null || rank === undefined) return [];
  return ids.filter((other, otherIndex) => other !== id && ranks[otherIndex] === rank);
}
