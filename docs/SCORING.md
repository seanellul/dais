# Scoring

How Dais turns judges' scores into results, how that matches the director's
Excel workbook, what is still open to interpretation, and how to check the
engine against a real spreadsheet.

The engine lives in `src/domain/scoring/`. It is pure TypeScript with no
framework, database or Node imports, so it runs unchanged in the browser, on
the server and in tests. The app calls one function:

```ts
import { computeDivisionResults, WORKBOOK_POLICY } from "@/domain/scoring";

const results = computeDivisionResults({
  divisionId,
  rounds: [1, 2, 3],
  debaters,
  teams,
  expectedSheets,
  scores,
  overrides,
  policy: WORKBOOK_POLICY,
  topN: 2,
});
```

Internal code uses technical names (lop, unresolved, bounds). Everything a
user reads uses the tournament's words: _set aside_ and _kept_, _can't be
scored yet_, _average_, _spread_ and _kept range_.

## 1. The rule in one paragraph

Each judge gives each debater an Overall score out of 103. For each debater,
Dais takes the **average** and the **spread** (standard deviation) of all
their scores, builds a **kept range** of average ± 2 × spread, and **sets
aside** any score outside it. Each round's result is the average of that
round's kept scores. A debater's total is the sum of their three round
results. A team's total is the sum of its two debaters' totals. Ranks follow
Excel's `RANK.EQ`: equal totals share a rank and the next rank has a gap.
Two totals are equal when they agree to 15 significant digits (see
section 5, item 11).

## 2. The policy knobs

The workbook value is the default. Every knob is a tournament setting and the
organiser sees the whole policy as one sentence (`describePolicy`).

| Knob                    | Workbook value | Other values | What it means                                                                                                                                                                                                 |
| ----------------------- | -------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdMultiplier`          | `2`            | any number   | Half-width of the kept range, in spreads: average ± 2 × spread.                                                                                                                                               |
| `bounds`                | `strict`       | `inclusive`  | A score exactly on the edge of the kept range is set aside (strict) or kept (inclusive). Excel's `AVERAGEIFS` with `"<"` and `">"` is strict.                                                                 |
| `scope`                 | `pooled`       | `perRound`   | The average and spread are taken over all of a debater's scores from every round (pooled, the workbook) or over each round's scores separately.                                                               |
| `passes`                | `one`          | `iterative`  | Set scores aside once, or rebuild the kept range from the kept scores and check again until nothing more is set aside (at most 10 passes). Each set-aside score records the pass that removed it.             |
| `sd`                    | `sample`       | `population` | `STDEV.S` (divides by n − 1) or `STDEV.P` (divides by n).                                                                                                                                                     |
| `whenUndefined`         | `unresolved`   | `keepAll`    | Fewer than two scores, so there is no spread. The workbook shows `#DIV/0!`; Dais says the debater can't be scored yet and lists why. `keepAll` keeps every score instead.                                     |
| `zeroSpread`            | `unresolved`   | `keepAll`    | Every score the same, so the spread is zero and a strict range keeps nothing. Same choice as above.                                                                                                           |
| `excelCriteriaRounding` | `true`         | `false`      | Round each edge of the kept range to 15 significant digits before comparing. Excel builds the criteria as text (`"<" & AY5`) and writes at most 15 significant digits, so this is what the workbook compares. |

Two presets are exported:

- `WORKBOOK_POLICY`: the values in the table. The sentence reads: _"The
  average and sample spread are taken over all of a debater's scores from
  every round; scores on or outside the kept range (average ± 2 × spread,
  rounded to 15 significant digits as Excel does) are set aside once; a
  debater with fewer than two scores or with every score the same can't be
  scored yet."_
- `WORKBOOK_SAFE_POLICY`: the same, but `whenUndefined` and `zeroSpread` are
  `keepAll`. Recommended for rooms with a single judge.

`policyEquals` compares two policies knob by knob and `canonicalPolicyJson`
gives a stable string for hashing. The policy is stamped on every published
result and export, so a later policy edit can never silently change a result.

## 3. What the engine reports

`computeDivisionResults` returns, for the division:

- **debaters**: one `DebaterResult` each, with the statistics that built the
  kept range (`stats`), one entry per round (`rounds[]`, each with the average
  and every score as a `SourceOutcome`), the `total`, the `status` (`ready`
  or `unresolved`), plain-English `reasons` when it can't be scored yet, the
  `rank`, the ids it is `tiedWith`, whether it is `provisional`, and the
  overrides that touched it.
- **teams**: `TeamResult` keyed by team id (never by name, so "Red" and
  "Red " cannot split a team), with `status` `ready`, `unresolved` (a member
  can't be scored yet, or the organiser took every member out) or
  `incomplete` (only one debater counts and no `rank_single_speaker_team`
  override says how to rank the team). A debater the organiser took out with
  `exclude_debater` does not count towards the team's total.
- **ranking**: ids in rank order, plus the unranked ones with their reasons.
- **ties**: every shared rank, for debaters and for teams.
- **top**: the `topN` teams for the final. When the nth and (n+1)th teams
  share a rank, `tieAtCut` names them and only the teams above the cut are
  listed; there is no automatic tie-break. `resolved` is false while any team
  is provisional, can't be scored yet or still waits for the organiser's
  decision (`incomplete`).
- **completeness**: expected and received sheet counts, the missing sheets
  (with `waived`), orphaned sheet ids, `provisional` (any missing sheet that
  is not waived), `finalizable`, and `blockers`, a plain-English list of
  what still stands in the way of publishing. Each problem is listed once: a
  missing sheet is one line, and a debater who is only waiting for that sheet
  is not listed again.

`DivisionInput.scores` holds one row per sheet and debater. When several
versions of the same sheet are passed (both versions after a resolution, or
a replayed sync), the highest `sheetVersion` wins.

Each score's `SourceOutcome.status` is one of:

| Status       | Meaning                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `retained`   | Kept by the policy.                                                                                                            |
| `lopped`     | Set aside by the policy. `pass` says which pass; `onBoundary` is set when the score sits exactly on an edge of the kept range. |
| `forced_in`  | Set aside by the policy, kept by an organiser override (`overrideId`).                                                         |
| `forced_out` | Kept by the policy, set aside by an organiser override.                                                                        |

Each round's `status` is `ready`, `unresolved` (with a `reason`) or `missing`
(a sheet for that round is outstanding and no score has arrived). Reasons:
`no_scores`, `sheet_missing`, `no_retained_scores` (every score was set
aside), `sd_undefined` (fewer than two scores), `zero_spread`.

### Partial results

A debater who can't be scored yet never removes anyone else's rank. Ranks are
computed over the debaters who are ready; the others are listed separately
with their reasons. When a sheet is missing, the numbers still show, every
affected debater and team is marked `provisional`, and publishing is held
back by a blocker until the sheet arrives or the organiser waives it.

### Overrides

Overrides are organiser decisions, applied after the policy, each with a
reason. The server writes the audit row.

| Kind                       | Applies to                                     | Effect                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `force_include`            | one score (`assignmentId` **and** `debaterId`) | A set-aside score is kept (`forced_in`).                                                                                                                                                           |
| `force_exclude`            | one score (`assignmentId` **and** `debaterId`) | A kept score is set aside (`forced_out`).                                                                                                                                                          |
| `keep_all_for_debater`     | `debaterId`                                    | Every score is kept, whatever the policy says. The fix for a zero-spread or single-score debater without changing the division's policy.                                                           |
| `exclude_debater`          | `debaterId`                                    | The debater is taken out of the ranking (`unresolved`, reason names the organiser). Not a blocker: it is an explicit decision. The team then has one counted debater and needs a decision (below). |
| `waive_missing_sheet`      | `assignmentId`                                 | The sheet will never arrive. It leaves the blockers and stops marking results provisional.                                                                                                         |
| `rank_single_speaker_team` | `teamId`                                       | A team with one counted debater (the other missing or taken out) is ranked on that single total. Until it is added the team is `incomplete` and a blocker.                                         |

A sheet scores every debater in the room, so `force_include` and
`force_exclude` need both ids. An override that names only the sheet touches
nothing rather than flipping four results.

When two overrides touch the same score, the later one in the list wins.

## 4. Workbook mapping

The director's Master Sheet has one debater per row, teammates on adjacent
rows, and per round five (judge code, score) slot pairs. The golden CSV in
`tests/fixtures/workbook-golden.csv` uses the same layout: rows 5–44 hold the
forty debaters. The columns and the formula each engine step reproduces:

| Column(s) in the golden CSV | Contents                                                          | Excel formula (row 5)                                           | Engine                            |
| --------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| A–E                         | School, Pair, Team, Code, Debater                                 | —                                                               | `DivisionInput.teams`, `debaters` |
| G, I, K, M, O               | Round 1 judge scores (F, H, J, L, N hold the judge codes as text) | —                                                               | `ScoreSource.value`               |
| U, W, Y, AA, AC             | Round 2 judge scores                                              | —                                                               |                                   |
| AI, AK, AM, AO, AQ          | Round 3 judge scores                                              | —                                                               |                                   |
| AW                          | Average                                                           | `=AVERAGE(G5,I5,K5,M5,O5,U5,W5,Y5,AA5,AC5,AI5,AK5,AM5,AO5,AQ5)` | `stats.mean`                      |
| AX                          | Spread (Std. Deviation)                                           | `=STDEV.S(G5,I5,K5,M5,O5,U5,W5,Y5,AA5,AC5,AI5,AK5,AM5,AO5,AQ5)` | `stats.sd`                        |
| AY                          | +2 SD                                                             | `=AW5+2*AX5`                                                    | `stats.upper`                     |
| AZ                          | −2 SD                                                             | `=AW5-2*AX5`                                                    | `stats.lower`                     |
| P                           | Round 1 average                                                   | `=AVERAGEIFS(G5:O5,G5:O5,"<"&AY5,G5:O5,">"&AZ5)`                | `rounds[0].average`               |
| AD                          | Round 2 average                                                   | `=AVERAGEIFS(U5:AC5,U5:AC5,"<"&AY5,U5:AC5,">"&AZ5)`             | `rounds[1].average`               |
| AR                          | Round 3 average                                                   | `=AVERAGEIFS(AI5:AQ5,AI5:AQ5,"<"&AY5,AI5:AQ5,">"&AZ5)`          | `rounds[2].average`               |
| Q, AE, AS                   | Round team score                                                  | `=SUMIF($D$5:$D$44,D5,P$5:P$44)` (and AD, AR)                   | not exposed                       |
| R, AF, AT                   | Round individual rank                                             | `=RANK.EQ(P5,P$5:P$44,0)` (and AD, AR)                          | not exposed                       |
| S, AG, AU                   | Round team rank                                                   | `=(RANK.EQ(Q5,Q$5:Q$44,0)+1)/2` (and AE, AS) — assumed, see 5.6 | not exposed                       |
| BA                          | Individual total                                                  | `=P5+AD5+AR5`                                                   | `total`                           |
| BB                          | Team total                                                        | `=SUMIF($D$5:$D$44,D5,BA$5:BA$44)`                              | `TeamResult.total`                |
| BC                          | Individual rank                                                   | `=RANK.EQ(BA5,BA$5:BA$44,0)`                                    | `rank`                            |
| BD                          | Team rank                                                         | `=(RANK.EQ(BB5,BB$5:BB$44,0)+1)/2` — assumed, see 5.6           | `TeamResult.rank`                 |

The two team-rank formulas are marked _assumed_: the folded `(rank + 1) / 2`
form is Dais's reading, not a formula copied from the workbook. Section 5,
item 6 and section 6 say how to check it.

Notes on the mapping:

- The `AVERAGEIFS` ranges include the judge-code cells. They are text, so
  Excel ignores them. In the golden CSV the codes are `J01`…`J15`.
- `AVERAGEIFS` with `"<"` and `">"` is strict: a score exactly on the edge is
  set aside. Excel writes the edge into the criteria text with at most 15
  significant digits, which `excelCriteriaRounding` reproduces.
- A row with fewer than two scores, or with every score the same, shows
  `#DIV/0!` in the round averages and the total. Dais reports the debater as
  _can't be scored yet_ with the reason, and ranks everyone else.
- The team rank column lists every team twice (one row per debater), so a
  plain `RANK.EQ` over it gives 1, 1, 3, 3, …. The `(rank + 1) / 2` form
  folds that into one rank per team, which is what Dais reports.

## 5. Known ambiguities

These are choices the workbook makes silently, or cases it does not decide.
Each is a policy knob or an organiser override, and each is a question for
the tournament director (see `docs/QUESTIONS-FOR-IAN.md`).

1. **Scope.** The workbook pools every score across all rounds. A literal
   reading of the rules ("the panel's scores for that debate") is per round.
   Note that with n scores the largest possible distance from the average is
   (n − 1) / √n spreads, which is under 2 for n < 6: a lone rogue score in a
   room of up to five judges is never set aside under a per-round policy at
   2 × spread.
2. **Edges.** Strict (workbook) or inclusive. It only matters when a score
   sits exactly on average ± 2 × spread.
3. **Passes.** One pass (workbook) or repeated until stable.
4. **Zero spread and single scores.** The workbook shows `#DIV/0!`. Dais
   defaults to _can't be scored yet_ so the organiser decides; the safe
   policy or a `keep_all_for_debater` override keeps the scores.
5. **`RANK.EQ` with an error in the range.** The emulator cannot decide how
   Excel ranks the other rows when one row is `#DIV/0!`. Dais ranks the
   debaters who are ready and lists the rest, which is the wanted behaviour
   either way. The equivalence tests compare ranks only over sets where every
   row resolves, and the golden fixture has no `#DIV/0!` cell.
6. **Team rank in a two-rows-per-team sheet.** See the note above. Whether
   the workbook folds the two rows per team is not known; the golden CSV
   assumes it does. The order is the same either way; only the numbers
   differ (1, 1, 3, 3, … unfolded against 1, 2, … folded).
7. **15-significant-digit rounding.** It can only change a decision when a
   score sits within 1 in 10¹⁵ of an edge. With whole-number scores no such
   case was found in 30 million random sets; the knob exists so the engine
   compares exactly what Excel compares. The unit test uses decimal scores
   (61.8, 61.8, 61.8, 61.8, 56.3, 87.1) to show the effect.
8. **Excel's own arithmetic.** Excel's `STDEV.S` may differ from a two-pass
   calculation beyond the 15th significant digit. The rounding erases that
   except in the same astronomically rare case as above.
9. **A sheet that never arrives.** Dais averages the remaining judges and
   holds publishing until the organiser waives the sheet with a reason.
10. **One-person teams.** Unranked until the organiser adds
    `rank_single_speaker_team`. The same applies when the organiser takes one
    of two debaters out with `exclude_debater`.
11. **Ties.** Two totals are equal when they agree to 15 significant digits.
    A total is a sum of round averages, and the same fractions added in a
    different round order can differ in the last binary digit (80 + 80⅓ + 80⅓
    against 80⅓ + 80⅓ + 80). Excel writes and compares 15 significant digits,
    and the emulator's `RANK.EQ` does the same, so such debaters tie rather
    than being ranked apart. A difference beyond the 15th digit that is real
    (not a rounding artefact) cannot come from whole-number scores.

## 6. Verifying the golden fixture in Excel

`tests/fixtures/workbook-golden.csv` is forty invented debaters with expected
values already filled in. Every name and number is invented; the file is
generated from a fixed seed by `tests/fixtures/generate-workbook-golden.ts`,
so it can be regenerated byte for byte:

```sh
pnpm exec tsx tests/fixtures/generate-workbook-golden.ts
```

To check the engine against a real spreadsheet once:

1. Open the CSV in Excel (or LibreOffice). Rows 1–4 are headers; rows 5–44
   are the debaters. Column D holds the team code and columns F–AQ the judge
   codes and scores in (code, score) pairs.
2. In row 5, to the right of the data (column BF onwards), type the formulas
   from the table in section 4, one per column: Average, Spread, +2 SD,
   −2 SD, the three round averages, the total, the team total, the two ranks.
   Point the formulas at the CSV's own cells (G5, I5, … for scores). For the
   two team-rank columns, do not type the table's formula blindly: open the
   real Master Sheet, read its own team-rank formula, and type that one. The
   table's `(RANK.EQ(…)+1)/2` is an assumption (section 5, item 6); if the
   workbook uses a plain `RANK.EQ`, the check will read `FALSE` on every
   team-rank cell and the numbers 1, 1, 3, 3, … are the expected difference.
3. Fill row 5 down to row 44.
4. Beside each formula column, add a check such as
   `=ABS(BF5-AW5)<0.000000001`, and fill down. Excel reads only 15
   significant digits from the CSV, so compare with a tolerance rather than
   with `=`.
5. Every check should read `TRUE`. The set-aside scores in the fixture (13 of
   them) are the cells that fall outside the row's −2 SD … +2 SD range; the
   round averages skip them.

If a check reads `FALSE`, the difference is the ambiguity to resolve, and the
policy knob or override above is how Dais records the decision.

## 7. Tests

- `tests/unit/scoring/prototype-port.test.ts`: the eleven cases from the
  prototype's `scoring.test.mjs`, same expected numbers.
- `tests/unit/scoring/lop.test.ts`, `rank.test.ts`, `describe.test.ts`,
  `division.test.ts`: each knob, partial ranking, teams by id, overrides,
  waivers, ties, the top-two selection, per-judge attribution.
- `tests/unit/scoring/excel-emulator.ts`: the test-only Excel emulator
  (`AVERAGE`, `STDEV.S`, `AVERAGEIFS` with text criteria, `SUM`, `RANK.EQ`)
  with its own tests in `excel-emulator.test.ts`.
- `tests/unit/scoring/workbook-equivalence.test.ts`: a fast-check property
  over 500 synthetic divisions (4–40 debaters, 1–5 judge slots per round with
  blanks, whole-number scores 40–103 with 5% rogue scores) and the golden
  fixture, asserting exact agreement with the emulator.

Run them with `pnpm exec vitest run tests/unit/scoring`.
