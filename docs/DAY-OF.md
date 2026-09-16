# Day-of runbook

A skeleton to fill in for each tournament. Print it. The organiser's laptop, a projector and every judge's phone are the whole system; this page says what to do with them, in order, and what to do when something fails.

Words in **bold** are the buttons and states you will see on screen.

## The week before

- [ ] Create the tournament (or **Duplicate** last year's). Set divisions, rounds, rubric, panel mode and judges per room in **Settings**.
- [ ] Paste the team list from the director's spreadsheet into **Teams**. Fix every issue chip. Check the team codes.
- [ ] Add judges in **Judges**. Print the **QR cards** (A6). One per judge, with the short code printed as the fallback.
- [ ] Set up **Rooms and panels**. Read the capacity sentence: it tells you if you are short of judges.
- [ ] **Draw** both divisions. Note the draw seed on this page: `__________`. Fix every **draw check**. **Publish** the draw.
- [ ] Print **door sheets**, **team itineraries** and a few **blank scoresheets** per room (paper fallback).
- [ ] Send the public page link (`/p/<slug>`) to coaches: schedule by room and by team.
- [ ] Hosted on Vercel: set the GitHub variable `KEEPALIVE=1` the evening before. Self-hosted: charge the laptop, test the hotspot.
- [ ] Run the demo once end to end on the projector, including a real phone.

## Judge briefing (15 minutes, with phones out)

1. **Install the app and open it once online.** Judges scan their QR card. The app says **"You're signed in as … , Room …"**. Ask them to tap **Add to home screen** (iOS: Share → Add to Home Screen; Android: the install banner). Then open it from the home screen once. The app shows **"Ready to work without signal"** when it has cached everything.
2. Show one sheet: **Before you score** (motion, sides, role swap), the four debaters in speaking order, the three categories out of 33 with band labels, **No rebuttal attempted = 13**, points of information 0–4, the **Overall out of 103**, and the two comment boxes. Scores above 90 are very rare.
3. Explain the receipt line: **Sending**, **Received by the tournament at 11:04**, **Waiting for connection**, **Needs attention**. A sheet is never lost; it waits on the phone. If a phone will not send, **Hand off to the organiser**: show the QR to the desk.
4. Wait for the Prime Minister's reply before finishing the PM's scores. Do not announce a winner.
5. Organiser's phone number for the day: `__________`. Written on the door sheets too.

## During rounds

**Live board** (`Rounds → Round N`), on the projector in presentation mode. Each cell is one judge seat.

The labels below are the user-facing terms from `docs/GLOSSARY.md`. The UI's messages file is the source of truth for the exact wording on screen.

| Cell                      | Meaning                                                     | Do                                                                                               |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Not yet in**            | The debate is probably still running.                       | Nothing.                                                                                         |
| **Waiting to send**       | Saved on the phone, waiting for signal.                     | Nothing yet. If the room is done and it stays waiting for 5 minutes, walk over.                  |
| **last seen 12 min ago**  | The judge's phone has not spoken to the server for a while. | Check the judge's phone: Wi-Fi off? App closed?                                                  |
| **In**                    | Received by the tournament.                                 | Nothing.                                                                                         |
| **Two versions**          | The judge sent a changed sheet.                             | Open the sheet drawer, compare side by side, **Keep current** or **Use incoming** with a reason. |
| **The draw changed**      | The draw changed after the sheet started.                   | Attach it to the new sheet from the **unmatched sheets** tray, or discard with a reason.         |
| **Missing** (after close) | The round is closed and nothing arrived.                    | Type in from paper, take a hand-off, or **Mark as won't arrive** with a reason.                  |

Between rounds:

- Announce the next round only when every room's cells are green or explained.
- **Results** are provisional all day. It is fine to look; the banner names what is missing.
- Any change to the draw after sheets exist shows a diff preview; read it before saving.

## If the Wi-Fi dies

Phones keep working. Sheets wait on the phone and send when signal returns, even after the app is closed and reopened.

1. Tell judges: keep scoring, ignore the **Waiting for connection** line.
2. If the venue Wi-Fi shows a sign-in page, the app says **"This Wi-Fi wants you to sign in first. Your sheet is safe on this phone."** Judges can use mobile data instead.
3. If a phone must give up its sheet now: **Hand off to the organiser**. The desk scans the QR with the laptop's camera (**Enter hand-off** on the live board) or types the read-out code and the numbers. When the phone syncs later, the app recognises the same numbers and adds only the comments.
4. If the internet is gone for the day and Dais is hosted online: switch to paper. Type sheets in from paper (**Type in from paper**, with the judge's name) as they arrive. Results and exports work the same.
5. If the venue has no internet by design, run Dais on the laptop before the day (`docker compose up` or the venue script) with the judges' phones on the laptop's hotspot. Note: an installable, offline judge app needs HTTPS; over plain HTTP judges use the browser without installing.

## After the last round

- [ ] Every cell green or explained. **Publish results** for each division; the checklist will refuse until every sheet is received or waived and every two-versions case is resolved.
- [ ] Confirm the **finalists** (a tie at the cut asks for a reason).
- [ ] **Exports:** the director's workbook (XLSX), the five CSVs, the per-school feedback packs, the results print.
- [ ] Download the **JSON backup** and store it with the organisation.
- [ ] Judges: **sign out devices** in **Judges** so phones no longer hold a session.
- [ ] Hosted on Vercel: set `KEEPALIVE=0`.
- [ ] Note what went well and even better if, then file a **Tournament day report** on GitHub (no names, no scores).

## Contacts and notes for this tournament

| Role               | Name | Phone |
| ------------------ | ---- | ----- |
| Organiser (desk)   |      |       |
| Second organiser   |      |       |
| Venue IT           |      |       |
| Technical fallback |      |       |

Draw seed: `__________` · Tournament address: `__________` · Join code prefix: `__________`
