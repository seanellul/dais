# Judge scoring without signal

## Before the day

The judge app lives at `/j`. It needs an initial successful online visit, sign-in, schedule download and a production service worker before offline use. Use trusted HTTPS for phones. `http://localhost` is a browser exception on the same computer; `http://<laptop-LAN-address>` on a phone is not. Plain LAN HTTP can serve an online scoring page but cannot register the service worker or promise offline reopening. Installing a home-screen icon does not bypass this restriction.

Check the app’s offline-readiness message before disconnecting. A development server is not the offline acceptance environment. Rehearse on the actual hosted origin and the phone/browser judges will use. Browser emulation and `context.setOffline` tests do not prove real-device behaviour; real-phone release verification remains a separate gate.

## What is saved where

| State                          | Location                        | Meaning                                                                             |
| ------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------- |
| Draft                          | Phone IndexedDB                 | Current scores/comments are saved locally; the organiser has no receipt yet         |
| Waiting/sending                | Phone outbox                    | An immutable submission with its request ID is waiting or in flight                 |
| Received                       | Server receipt/version          | The tournament has accepted the submission; receipt information is retained locally |
| Needs attention / two versions | Server and phone recovery state | A conflict, revoked access or changed assignment needs an explicit decision         |

Overall is independent of the category total. Readiness to finish, local saving and receipt are different states. The organiser’s heartbeat view is the phone’s last reported state, not proof of a received sheet. Check the receipt and the live board together.

Keep the app’s browser storage intact until sheets have receipts. Clearing site data, private-browsing expiry, OS storage eviction or losing a device can remove local-only work. Opening a second tab is not a backup; the app coordinates editing on that browser and can show another-tab ownership. Use the original tab or its recovery controls.

## Sending and retry

The phone retains submissions and stable request IDs. It retries when the app can connect; an offline or captive-portal response is not a receipt. Foreground reopening and reconnecting allow sync to resume. Do not rely on background delivery after the browser has been closed.

If Wi-Fi requires a sign-in page, complete its login or use mobile data, then reopen Dais. A “Received” receipt is the confirmation. Retryable server/database errors keep work queued and back off. Access revoked or an expired demo requires attention rather than unlimited retries.

An app update waits while work is outstanding. Receive or resolve saved sheets before accepting an update. Do not clear storage to force a new app version.

## Phone hand-off

When the desk can reach the tournament but a judge’s phone cannot:

1. On the phone, choose the hand-off option for the intended sheet.
2. Transfer the **full checked text or QR contents** to the organiser. The QR is an encoding of the same full payload. In the organiser form, choose a clear QR image or photo to decode it locally, or paste the full text. The image is not uploaded; decoding fills the text field for review and an explicit Receive decision. This is photo/file scanning, not live video. The six-digit checksum alone cannot identify or reconstruct the scores.
3. In the round’s live board, open the correct judge seat, expand **Enter a phone hand-off**, paste the full text and enter a reason. The checked codec validates the payload; the service verifies assignment, judge and sheet compatibility before recording it.
4. Keep the original phone draft and send request. When the phone later retries, matching numbers with its original comments can return a comments-only conflict. The organiser selects **Merge comments** with a reason; the following retry returns the settled receipt. Different numbers require a version decision.

The compact hand-off carries numbers, sides/roles and request identity, not the full written feedback. Never assume a hand-off alone delivered the comments. The organiser must review the retry and make the appropriate decision. Do not paste tokens, full hand-offs or private feedback into public issue reports.

## Changed draws and paper fallback

A changed assignment preserves the original sheet. An organiser can attach it to a successor only when the explicit debater mapping is identity-compatible, or discard its expectation with an audited reason. Discard retains history and does not excuse a successor’s still-missing sheet. Open old conflicts are explicitly settled by that recovery decision without losing their incoming payloads.

Use **Type in from paper** when needed. Compare two versions before choosing current, incoming or matching-number comment merge. Waive a sheet only when it will not arrive, with a reason; publication blockers remain until completeness is resolved.

If both the phones and the desk cannot reach a hosted tournament, hand-off cannot update that server. Keep scoring locally or use paper, preserve the records and enter/sync them after service returns. Prepare a local deployment before the event if it is the intended fallback; changing to a different origin does not move drafts or sessions from the first origin automatically.

## End of event

Download the JSON backup and exports, confirm all receipts/conflicts, and choose **Sign out all devices** for each judge. This revokes access judge-wide and rotates the card. Individual heartbeat rows are informational; there is no per-device sign-out action. Do not erase local drafts before the organiser confirms recovery is complete.
