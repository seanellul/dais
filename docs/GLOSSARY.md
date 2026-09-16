# Glossary

Dais has two vocabularies. Code, database columns and log lines use the internal term. Everything a judge, organiser, coach or debater reads uses the user-facing term. Pull requests that put an internal term on screen are sent back.

Spelling is British English (organiser, colour, licence). All user-facing strings live in one messages file so other spellings and languages can be added later.

## People and things

| Internal term                | User-facing term                                                                 | Meaning                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| organisation, org            | organisation                                                                     | The group that owns tournaments, for example a charity or a school league.                    |
| organizer                    | organiser                                                                        | A person who runs the day from the dashboard.                                                 |
| user                         | organiser                                                                        | An organiser account (email and password).                                                    |
| judge                        | judge                                                                            | A volunteer who scores debates on a phone. Signs in with a code or QR, never with a password. |
| speaker, contestant, student | debater                                                                          | A person who debates. "Speaker" is used only for the speaking roles.                          |
| team                         | team                                                                             | Two debaters from one school, with a team code.                                               |
| team code                    | team code                                                                        | The short code (O07, N03) the random draw uses. The rules say draws are by code.              |
| division                     | division                                                                         | Open or Novice. Scored and ranked separately.                                                 |
| room                         | room                                                                             | Where a debate happens.                                                                       |
| debate                       | debate                                                                           | One room in one round: a Government team against an Opposition team.                          |
| motion                       | motion                                                                           | What the debate is about. The rules also say "resolution".                                    |
| PM, LO, GM, OM               | Prime Minister, Leader of the Opposition, Government Minister, Opposition Member | The four speaking roles. Abbreviations only in tight grids.                                   |
| government / opposition      | Government / Opposition                                                          | The two sides. "Gov" / "Opp" only in tight grids.                                             |
| tournament kind: sandbox     | sandbox                                                                          | A practice copy of a tournament.                                                              |
| tournament kind: demo        | demo                                                                             | A public, fictional tournament that resets itself.                                            |
| workspace                    | tournament                                                                       | (Prototype term, retired.)                                                                    |

## The draw and panels

| Internal term                | User-facing term        | Meaning                                                                                      |
| ---------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| schedule, allocation (teams) | draw                    | Which teams meet in which room in which round.                                               |
| allocation (judges), panel   | panel                   | The judges in one room.                                                                      |
| panel mode: fixed-room       | judges stay in one room | Each judge keeps the same room all day.                                                      |
| panel mode: per-round        | judges move each round  | Panels are drawn again for every round.                                                      |
| draw seed                    | draw seed               | The number that makes the random draw reproducible from the team list.                       |
| revision                     | (hidden)                | Setup version counter. Shown as "Updated 11:04 by Sam".                                      |
| validation issue             | draw check              | A rule the draw breaks, in words, with a link to fix it.                                     |
| sides decided: in-advance    | sides set in advance    | Government and Opposition are fixed when the draw is published.                              |
| sides decided: in-room       | coin toss in the room   | Sides are decided in the room before the debate. Each judge records the result on the sheet. |
| side flip                    | sides swapped           | The toss put the drawn Opposition on Government.                                             |
| role swap                    | roles swapped           | The two teammates spoke in the other order.                                                  |

## Sheets

| Internal term                        | User-facing term                                | Meaning                                                                                      |
| ------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| assignment                           | sheet                                           | One judge's scoresheet for one debate.                                                       |
| assignment retired, stale allocation | the draw changed, old draw                      | The debate this sheet was for no longer exists in that form.                                 |
| successor                            | the new sheet                                   | The sheet that replaced an old-draw sheet.                                                   |
| submission, receipt                  | received, "Received by the tournament at 11:04" | The server has stored the sheet.                                                             |
| queued, pending                      | waiting to send, waiting for connection         | Saved on the phone; will send when there is signal.                                          |
| sending                              | sending                                         | On its way.                                                                                  |
| blocked                              | needs attention (with a reason)                 | Cannot send by itself; the judge picks an exit: retry, edit and resubmit, hand off, discard. |
| conflict (version)                   | two versions                                    | Two different versions of one sheet exist; the organiser chooses.                            |
| conflict: comments_only              | two versions of the comments                    | Scores match, only the comments differ; one tap adds them.                                   |
| resolve keep / incoming              | keep current / use incoming                     | The organiser's choice between two versions.                                                 |
| baseVersion, version                 | (hidden)                                        | Which version the judge started from.                                                        |
| request id (submission)              | (hidden)                                        | Makes resending safe: the same sheet is never stored twice.                                  |
| manual entry                         | type in from paper                              | The organiser enters a paper sheet.                                                          |
| correction                           | correct scores                                  | The organiser changes a stored sheet, with a reason.                                         |
| waiver                               | mark as won't arrive (waived)                   | The organiser records that a sheet will not come; results proceed without it.                |
| tombstone                            | discarded sheet                                 | A sheet the judge discarded. Kept, never deleted, with undo.                                 |
| hand-off                             | hand off to the organiser                       | Giving the sheet to the organiser by QR code or read-out code when a phone cannot send.      |
| device heartbeat                     | last seen 2 min ago                             | When the judge's phone last spoke to the server.                                             |
| sync, flush                          | send                                            | Pushing waiting sheets to the server.                                                        |
| session, token                       | this phone is signed in as...                   | A judge device's login.                                                                      |
| revoke                               | sign out device                                 | Ends a judge device's login from the dashboard.                                              |
| WWW / EBI                            | What went well / Even better if                 | The two feedback fields per debater.                                                         |
| POI                                  | Points of information                           | The 0–4 rubric category.                                                                     |
| overall                              | Overall score (out of 103)                      | The independent mark that counts.                                                            |

## Scoring and results

| Internal term                           | User-facing term                                    | Meaning                                                                           |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| lopping, exclusion                      | set aside                                           | A score outside the kept range is left out of the average.                        |
| retained, included                      | kept                                                | A score inside the kept range.                                                    |
| mean                                    | average                                             | A debater's average over every kept score.                                        |
| standard deviation, SD                  | spread                                              | How far the scores vary.                                                          |
| bounds, lower/upper                     | kept range, "scores between 62.4 and 96.0 are kept" | Average ± 2 × spread.                                                             |
| policy, WORKBOOK_POLICY                 | outlier policy, "how scores are set aside"          | The settings that decide what is set aside. Shown as one sentence.                |
| unresolved                              | can't be scored yet                                 | Not enough kept scores to give this debater a total; never blocks other debaters. |
| zero-spread                             | all judges gave the same score                      | A reason a debater can't be scored yet under the workbook policy.                 |
| insufficient-data                       | only one score so far                               | A reason a debater can't be scored yet.                                           |
| no-retained-scores                      | every score in Round N was set aside                | A reason a debater can't be scored yet.                                           |
| override: force_include / force_exclude | keep / set aside (with a reason)                    | The organiser's decision about one score.                                         |
| override: keep_all_for_debater          | keep every score for this debater                   | Bypasses the policy for one debater.                                              |
| override: rank_single_speaker_team      | rank this one-person team                           | Lets a one-person team appear in the team ranking.                                |
| standings, results                      | results                                             | Ranked debaters and teams.                                                        |
| provisional                             | provisional                                         | Results computed before every sheet is in. A normal state, not an error.          |
| finalize, lock                          | publish results                                     | Freezes a division's results and snapshots the policy.                            |
| finalized                               | results published                                   | The frozen state.                                                                 |
| unlock                                  | reopen results                                      | Un-freezes, with a reason and a snapshot.                                         |
| top-N, finalists                        | finalists                                           | The teams going to the final, with a tie warning at the cut.                      |
| RANK.EQ                                 | rank (ties share a rank)                            | Equal totals share a rank; the next rank is skipped, as in the workbook.          |

## System

| Internal term            | User-facing term                                                                                  | Meaning                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| audit_log                | history                                                                                           | Plain-sentence timeline of every change, with reasons.                                                        |
| snapshot                 | backup point                                                                                      | A stored copy taken before publish, reopen, restore or a draw save.                                           |
| backup (JSON)            | backup                                                                                            | A downloadable file that restores a tournament.                                                               |
| server error, 500        | "Something went wrong on the tournament server. Try again, or tell the organiser the request id." | Something failed; the message shows a request id to quote. The string lives in `src/server/errors.ts`.        |
| db_unavailable, 503      | "The tournament server is waking up. Try again in a moment."                                      | The database is asleep or unreachable; the app retries by itself. The string lives in `src/server/errors.ts`. |
| rate limited, 429        | "too many attempts, try again in N seconds"                                                       | A login or join code was tried too often.                                                                     |
| request id               | request id                                                                                        | The id on every error, matching one log line.                                                                 |
| service worker, precache | "ready to work without signal"                                                                    | The judge app is installed and cached for offline use.                                                        |
| captive portal           | "this Wi-Fi wants you to sign in first"                                                           | The venue Wi-Fi is intercepting requests; the sheet is safe on the phone.                                     |
| presentation mode        | presentation mode                                                                                 | Larger dashboard for a projector.                                                                             |
