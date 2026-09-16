# Questions for the tournament director

These are the decisions the rules and the workbook leave open. Each entry gives the current default to review and what changes if the answer differs. Most defaults are settings, not code.

Already agreed with Sean: prepare all three rounds in advance; judges stay in their allocated rooms and teams move between rooms.

## 1. Outlier scope: pooled or per round?

The workbook takes a debater's average and spread over **all three rounds together**, then sets aside any score outside average ± 2 × spread. A literal reading of the rules could mean per round.

**Default:** pooled over all rounds, strict boundary (a score exactly on the edge is set aside), one pass (the average is not recomputed after setting aside). This is `WORKBOOK_POLICY` and reproduces the director's workbook cell for cell.
**Setting:** Settings → Outlier policy (scope, boundary, passes). The policy is shown as one sentence on the results page.

## 2. When the spread is zero or there is only one score

The workbook shows `#DIV/0!` when a debater has one score, and sets aside every score when all judges agree exactly (spread zero means nothing is inside the range).

**Default:** the debater shows as **can't be scored yet** with the reason ("only one score so far" / "all judges gave the same score"). Other debaters are still ranked. The organiser can apply **keep every score for this debater** with a reason.
**Alternative:** the `WORKBOOK_SAFE_POLICY` preset keeps all scores automatically in both cases.

## 3. Whole numbers only?

**Default:** whole numbers for every category and for the Overall. Judges cannot type 84.5.
**Setting:** Settings → Rubric → "Whole numbers only".

## 4. Category total as a starting point for the Overall?

The three categories (33 + 33 + 33) and points of information (4) add up to 103, the same as the Overall's maximum, but the Guide to Judging treats the Overall as an independent assessment.

**Default:** fully independent. The sheet shows the category total for reference and never copies it into the Overall.
**Alternative:** a "use the category total" button, off by default.

## 5. Sides: fixed in advance or a coin toss, and who records the toss?

**Default:** rounds 1 and 2 have sides set in advance by the draw; round 3 (impromptu) has a coin toss in the room. Every judge on the panel records the toss result and any teammate role swap in "Before you score". If the panel disagrees, the organiser sees it on the live board.
**Setting:** per round, Settings → Rounds → "Sides: set in advance / coin toss in the room".

## 6. Tie-break for the top two Open teams

**Default:** the results page flags a tie at the cut and asks the organiser to **confirm finalists** with a reason. No automatic tie-break.
**Alternatives:** higher single-round total, head-to-head result, coin toss. Any of these can become the default once chosen.

## 7. Panel size (fixed rooms already confirmed)

**Confirmed:** judges stay in one room all day (fixed-room panels). Panels support 1 to 5 judges; the demo uses 3 per room. Confirm the expected panel size for the real event.
**Setting:** Settings → Rooms and panels → "Judges stay in one room" / "Judges move each round", and "Judges per room".

## 8. One-person teams

**Default:** the debater is ranked individually. The team shows as **can't be scored yet** in the team ranking unless the organiser applies **rank this one-person team** with a reason, which ranks it on its single total.

## 9. Team codes: pre-issued or generated?

**Default:** generated on import (O01, O02, … for Open; N01, N02, … for Novice) in the order the teams are pasted. If the pasted list has a code column, those codes are used instead.

## 10. Judge conflicts of interest

Should a judge never sit on a debate involving their own school?

**Default:** not enforced. The judge list has no school field yet and the draw checks do not look for it. The organiser edits panels by hand.
**If yes:** add a school per judge and a draw check "judge from the same school as a team", planned for after the first deployment.

## 11. Feedback delivery and judge names

**Current export:** a PDF grouped by school, with a section per debater containing each judge's "What went well" and "Even better if" across the three rounds. Judge names **are printed** on these private feedback sheets. Feedback is not shown on the public page.
**Decision:** keep judge names on coach copies, or anonymise them? Private per-debater links would be a separate feature.

## 12. What the public page shows on the day

**Default:** the schedule (by room and by team) as soon as the draw is published; results only once the organiser publishes them.
**Setting:** Settings → Public page → "Show provisional standings" (off by default).

## 13. If a judge's sheet never arrives

**Default:** the organiser marks the sheet as **won't arrive** with a reason. The debater is averaged over the remaining judges, a waiver row is recorded, and the results page keeps saying which sheet was waived. Results cannot be published while a sheet is neither received nor waived.

## 14. Branding

May the app use the ESU Cayman logo, fonts and colours? May the demo be branded as the tournament?

**Default:** the neutral theme. An ESU Cayman colour theme exists as an option without the logo. The demo tournament uses invented names and no sponsor branding. The product name is Dais everywhere; the tournament name appears only as that tournament's name.

## 15. A final between two teams that already met

The app holds that two teams meet at most once in a tournament: the draw and the database refuse a second debate between the same pair.

**Default:** the results page confirms the finalists (see 6); the final itself is run and scored outside the app.
**If the final should be scored in the app:** debates need a stage (preliminary / final) so the pair-once rule applies to preliminary rounds only. Planned only if asked.
