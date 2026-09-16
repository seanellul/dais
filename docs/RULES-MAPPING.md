# Rules mapping

Each rule of the tournament, as summarised from the Standing Rules and the Guide to Judging (February 2024), and the Dais feature or setting that implements it. The numbering here is Dais's own reference numbering of that summary; the original documents are not reproduced in this repository. Where the original numbering differs, please tell us and we will align this page.

"Setting" means an organiser can change it per tournament. "Fixed" means it is built in. "Out of scope" means Dais deliberately does not do it yet.

## Structure

| #   | Rule                                                                                    | Implemented by                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Two divisions, Open and Novice, scored and ranked separately.                           | Setting: Settings → Divisions (`TournamentSettings.divisions`). Every results page, export and publish action is per division.                                    |
| 2   | Three preliminary rounds.                                                               | Setting: Settings → Rounds (`TournamentSettings.rounds`). Default three; the draw, the checklist and the workbook export follow the count.                        |
| 3   | Rounds 1 and 2 are prepared motions; round 3 is impromptu with 15 minutes' preparation. | Setting per round: format `prepared` / `impromptu` (`RoundSetting.format`). The judge app shows the round's timings and the preparation reminder.                 |
| 4   | A separate championship final for the top two Open teams.                               | Results → Finalists card names the top two with a tie warning at the cut and "Confirm finalists" with a reason. **Out of scope: the final itself is not scored.** |
| 5   | Teams are two debaters from one school, identified by a team code.                      | Teams page and paste import (school, debater, team). Codes O01…/N01… generated or imported. Unique per division on code and on school + name.                     |

## The draw

| #   | Rule                                                                                                              | Implemented by                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Opponents are drawn at random using team codes.                                                                   | Draw dialog: seeded random shuffle of team codes feeding the circle method. The seed is shown and stored, so the draw can be reproduced from the seed and the team list. Seeded order is an alternate method. |
| 7   | No team meets the same opponent twice across the preliminary rounds.                                              | Fixed: the draw generator avoids repeats; the database rejects them (unique pair per division); the draw checks panel reports any repeat after a manual edit.                                                 |
| 8   | Each team debates exactly once per round; sides are balanced across the day.                                      | Fixed: one appearance per round per team (unique constraint); side orientation balances Government and Opposition. Draw check messages name the team.                                                         |
| 9   | Government and Opposition are set in advance for prepared rounds and decided in the room for the impromptu round. | Setting per round: `sidesDecided` `in-advance` / `in-room`. "Before you score" on the judge sheet records the coin toss and any teammate role swap; recorded on every sheet.                                  |
| 10  | A panel of judges (one to five) sits in each room; a judge sits in one room per round.                            | Rooms and panels page; seats 1–5 (`judgesPerRoom`); fixed-room or per-round panels (`panelMode`); the database forbids one judge in two rooms in one round.                                                   |

## In the room

| #   | Rule                                                                                                                               | Implemented by                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 11  | Speaking order: Prime Minister, Leader of the Opposition, Government Minister, Opposition Member, then the Prime Minister's reply. | Fixed order on the judge sheet (`RoleKey` pm, lo, gm, om). Role labels are a setting (`RoleLabels`). |
| 12  | Times: prepared 5 / 7 / 7 / 7 / 2 minutes; impromptu 4 / 5 / 5 / 5 / 1 minutes.                                                    | Setting: `SpeechTimings`. Shown in the judge app's help and printed on judge cards.                  |
| 13  | Points of information may be offered and are assessed.                                                                             | Rubric category "Points of information" 0–4 on every debater's sheet (`RubricCategory.poi`).         |
| 14  | Judges wait for the Prime Minister's reply before completing the Prime Minister's scores.                                          | Judge app reminder on the sheet and in help. Not enforced by software.                               |
| 15  | Judges do not announce a winner; preliminary rankings use points, not wins.                                                        | Fixed: the sheet has no "winner" field; the judge app's help says so.                                |

## Scoring

| #   | Rule                                                                                                                      | Implemented by                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 16  | Each debater is scored on argumentation, rebuttal and presentation (each out of 33) and points of information (out of 4). | Rubric categories with maxima (`Rubric.categories`). Inline band micro-labels and tappable rubric text.                              |
| 17  | An independent Overall score out of 103 is the score that counts.                                                         | `SpeakerScore.overall`; the category total is shown for reference only (see Questions 4).                                            |
| 18  | Bands: 87–103 Excellent, 81–86 Very good, 71–80 Competent, 66–70 Fair, 40–65 Ineffective. Scores above 90 are very rare.  | `Rubric.bands`; band bar under the Overall numeral with the "very rare" note.                                                        |
| 19  | When no rebuttal is attempted, rebuttal scores 13.                                                                        | "No rebuttal attempted = 13" chip (`Rubric.noRebuttalScore`).                                                                        |
| 20  | Judges give feedback: at least two positives and two suggestions per debater.                                             | "What went well" and "Even better if" per debater; `feedbackRequired` setting decides whether a sheet can be submitted without them. |
| 21  | Scores are whole numbers.                                                                                                 | Setting `Rubric.integersOnly` (default on). See Questions 3.                                                                         |

## Results

| #   | Rule                                                                                                                     | Implemented by                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22  | For each debater, scores at or beyond two spreads from their average (the workbook's strict range) are set aside.        | Outlier policy `WORKBOOK_POLICY` (pooled over all rounds, strict boundary, one pass, sample spread), the workbook's exact formula. Each set-aside score names the judge and the kept range. |
| 23  | A debater's round score is the average of the kept judge scores in that round; the total is the sum of the round scores. | `computeDivisionResults`: round averages, then sum. Verified against an Excel emulator and a golden fixture.                                                                                |
| 24  | A team's score is the sum of its two debaters' totals.                                                                   | Team totals keyed by team id. One-person teams: see Questions 8.                                                                                                                            |
| 25  | Debaters and teams are ranked by points within their division; equal points share a rank.                                | RANK.EQ semantics with gaps preserved; ties shown as ties.                                                                                                                                  |
| 26  | The director may remove or restore a score by hand.                                                                      | Keep / set aside overrides with a mandatory reason, audited and reversible. Published results snapshot the policy so a later edit never changes them silently.                              |
| 27  | Results are announced only when complete.                                                                                | Results stay **provisional** and name the missing sheets until every sheet is received or waived; "Publish results" runs a checklist; "Reopen" needs a reason.                              |

## Not covered by any rule, added for the day

| Feature                                               | Why                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Offline judge sheets, hand-off QR, type in from paper | Venue Wi-Fi fails; no sheet may be lost.                                    |
| Two versions of a sheet resolved by the organiser     | A judge may resend after an edit; nothing is overwritten silently.          |
| History with reasons                                  | Every override is defensible after the day.                                 |
| Director's workbook export with live formulas         | The director can check the app against the spreadsheet once, then trust it. |
