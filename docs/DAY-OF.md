# Tournament-day runbook

**Preview runbook.** Rehearse on the deployed build before using Dais at an event. Automated Chromium and phone-width checks do not replace a real-phone test. Confirm scoring rules in [SCORING](SCORING.md), [RULES-MAPPING](RULES-MAPPING.md) and [QUESTIONS-FOR-IAN](QUESTIONS-FOR-IAN.md).

## Ten-minute rehearsal with invented data

1. Open the landing page and choose **Try the live demo**. It creates an isolated 24-hour demo with a published draw and some round-1 sheets already received. Record the build/commit and origin.
2. In **Judges**, issue a QR card. On a real phone, scan it on the intended HTTPS origin and open the allocated sheet. Wait for offline readiness; record phone, OS and browser. Do not mark this step passed from desktop emulation.
3. Fill categories, POI, independent Overall and comments. Disconnect signal, finish the sheet, close/reopen the app and check the local work remains. Reconnect and confirm a receipt and the corresponding live-board seat.
4. Test a full-text/QR hand-off while the phone cannot connect and the desk can. Choose a clear QR photo/image (or paste full text) in the intended judge seat, review it and explicitly receive it. Reconnect the phone, review the original retry and merge matching-number comments with a reason. The six-digit checksum alone is not the sheet.
5. Use demo simulation controls for remaining sheets/rounds. Introduce and explicitly settle two versions. Review scoring traces, confirm finalists, publish each division and reopen with a reason.
6. Download XLSX, CSVs, a PDF and JSON backup. Open the workbook in desktop Excel and check for a repair prompt. Practise restore only in a disposable tournament.

Record pass/fail for each step. Hosted cold-start recovery, clean-clone setup and actual device/browser evidence are separate release gates; this document does not claim they have been completed.

## Before judges arrive

- [ ] Two organisers can sign in. The correct live tournament is selected, with approved rubric, scoring policy and public-page settings.
- [ ] Team import issues are resolved; team codes and debater spelling are checked.
- [ ] Judges are active; rooms and fixed panels have capacity for the expected judges per room.
- [ ] The draw checks pass, the visible seed is recorded, and the draw is published.
- [ ] Door sheets, team itineraries, judge cards and blank paper scoresheets are printed. Judge cards contain private access tokens; hand them to the intended judge.
- [ ] Use **Exports & print** links. If the public page is enabled, share its generated `/p/<slug>--<tournament-id>` link; provisional visibility is an explicit setting.
- [ ] The desk and phones can reach `APP_URL`, with trusted HTTPS for phone offline caching. A laptop `localhost` address is not reachable from another phone.
- [ ] Paper, contact numbers, charged devices and an agreed outage plan are ready.
- [ ] If configured, set GitHub `KEEPALIVE=1` and `APP_URL` for the event. Scheduled requests can be delayed; they do not guarantee uptime. Keep a round’s polling live board open.

## Judge briefing

1. Scan the assigned card and verify the judge, room, round and four debaters. Open the app online and wait for offline readiness before relying on it without signal. Home-screen installation is optional and does not by itself establish readiness.
2. Show the three categories out of 33, POI 0–4 and independent Overall out of 103. Show feedback and the rubric; confirm the event’s interpretation, including rebuttal and reply handling. Do not announce a winner from a single sheet.
3. Explain **saved on this phone**, **waiting to send** and the server **received** receipt. Keep saved work and avoid clearing browser data. If the phone needs attention, ask the desk.
4. Practise one complete hand-off. The desk needs full text or QR contents, the intended judge seat and a reason. Original comments may need the later phone retry and an organiser merge.
5. Give judges the desk contact number: `__________`.

## During rounds

Open the round from its live board. Presentation mode enlarges text; `p` toggles it when focus is outside an editable field. Each seat is a judge’s expected sheet; device status is a last-seen heartbeat.

| State                             | Desk action                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Not yet in                        | Check whether the debate is still running                                                              |
| Waiting to send / stale heartbeat | Check signal and the phone’s saved state; it is not a server receipt                                   |
| In                                | Confirm the receipt if needed                                                                          |
| Two versions                      | Compare and keep current, use incoming or merge matching-number comments, with a reason                |
| The draw changed / unmatched      | Review the original and compatible successor mapping; attach or discard the old expectation explicitly |
| Missing after close               | Enter paper, receive a full hand-off or waive a sheet that will not arrive, with a reason              |

Check every room before moving on. Close completed rounds; reopening restores the live workflow. A late sheet remains distinguishable by its receipt timing. Read draw-change protection previews before saving any post-scoring edit.

Results remain provisional while required sheets, conflicts or old-draw expectations are unresolved. Use the trace and reasoned keep/set-aside overrides; do not change a policy simply to silence a blocker.

## If connectivity fails

- Phones with a ready cached app continue scoring and retain queued submissions. Reopen after reconnecting; do not promise unattended background sync.
- For a captive portal, finish Wi-Fi login or try mobile data. A successful server receipt is the confirmation.
- If the desk is online, use full hand-offs or paper entry. If the hosted server is unreachable from the desk too, preserve local sheets/paper and reconcile when service returns.
- A prearranged local server can provide an online LAN fallback: `pnpm venue` binds to the LAN, prints a judge sign-in QR and stores separate PGlite data in `./data/venue`. Use `VENUE_ADDRESS` to select the intended interface and prepare the local tournament before the event. Plain HTTP on phones cannot run the service worker and does not provide offline reopening. Trusted HTTPS is required for that capability; see [OFFLINE](OFFLINE.md).
- A different server/origin does not inherit phone drafts or credentials. Rehearse the fallback before the day rather than rebuilding during a live outage.

## After the last round

- [ ] All required sheets are received or explicitly waived; version conflicts and unmatched old sheets are settled.
- [ ] Review results and confirm two eligible finalists for each division, recording a tie decision reason when required. Then publish.
- [ ] Reopen with a reason for later corrections. Changed scores/policy/waivers/roster invalidate old finalist confirmation; confirm again before publication.
- [ ] Download the workbook, six CSVs, feedback/results records and JSON backup; store them securely with the organisation.
- [ ] Choose **Sign out all devices** per judge. This is judge-wide revocation, not per-device sign-out; reissue cards if another event needs access.
- [ ] Set `KEEPALIVE=0` and review the data-retention plan.
- [ ] File a tournament-day report with build, browser/device and connectivity evidence. Remove names, scores, cookies, invite links and judge card tokens.

## Desk notes

| Role               | Contact |
| ------------------ | ------- |
| Organiser          |         |
| Second organiser   |         |
| Venue IT           |         |
| Technical fallback |         |

Draw seed: `__________` · Tournament origin: `__________` · Build/commit: `__________`
