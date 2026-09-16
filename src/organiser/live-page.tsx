"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import type { SheetPayload, SpeakerScore } from "@/domain/types";
import type { LiveBoard, SeatState } from "@/server/services/live";
import { decodeHandoff } from "@/judge/handoff";
import { Banner, NowCard, PageHeader, StatusChip } from "@/ui";
import { HandoffScanner } from "./handoff-scanner";
import {
  ActionForm,
  Check,
  Field,
  Reason,
  Table,
  number,
  text,
  useCommand,
  type Command,
  type Data,
} from "./controls";
const labels: Record<SeatState, string> = {
  "not-yet-in": "Not yet in",
  "in-phone": "In · phone",
  "in-paper": "In · paper",
  "in-corrected": "In · corrected",
  "in-handoff": "In · hand-off",
  late: "In · late",
  "two-versions": "Two versions",
  missing: "Missing",
  waived: "Won’t arrive",
  "old-draw": "Old draw",
  "queued-on-phone": "Waiting to send",
  drafting: "Drafting",
  "device-silent": "Device silent",
  "needs-attention": "Needs attention",
};
function scorePayload(f: FormData, assignment: Data["assignments"][number]): SheetPayload {
  const scores: Record<string, SpeakerScore> = {};
  for (const s of assignment.display.speakers)
    scores[s.id] = {
      argumentation: number(f, `${s.id}.argumentation`),
      rebuttal: number(f, `${s.id}.rebuttal`),
      presentation: number(f, `${s.id}.presentation`),
      poi: number(f, `${s.id}.poi`),
      overall: number(f, `${s.id}.overall`),
      www: text(f, `${s.id}.www`),
      ebi: text(f, `${s.id}.ebi`),
    };
  return {
    scores,
    sideFlipped: f.has("sideFlipped"),
    roleSwaps: Object.fromEntries(
      [assignment.identity.governmentTeamId, assignment.identity.oppositionTeamId].map((id) => [
        id,
        f.has(`swap.${id}`),
      ]),
    ),
  };
}
export function ScoresSummary({ payload, data }: { payload: SheetPayload; data: Data }) {
  return (
    <div>
      {Object.entries(payload.scores).map(([id, s]) => (
        <div key={id} className="py-2">
          <strong>
            {data.teams.flatMap((t) => t.speakers).find((d) => d.id === id)?.name ?? "Debater"}
          </strong>
          <p>
            {s.argumentation} / {s.rebuttal} / {s.presentation} / {s.poi} · Overall{" "}
            <strong>{s.overall}</strong>
          </p>
          {s.www && <p className="org-muted">What went well: {s.www}</p>}
          {s.ebi && <p className="org-muted">Even better if: {s.ebi}</p>}
        </div>
      ))}
      <p className="org-muted">
        Sides {payload.sideFlipped ? "swapped" : "as drawn"} ·{" "}
        {Object.values(payload.roleSwaps).filter(Boolean).length} teams swapped roles
      </p>
    </div>
  );
}
export function SheetDrawer({
  data,
  assignmentId,
  command,
  onClose,
}: {
  data: Data;
  assignmentId: string;
  command: Command;
  onClose: () => void;
}) {
  const a = data.assignments.find((a) => a.id === assignmentId);
  const sheet = data.sheets.find((s) => s.assignmentId === assignmentId);
  const conflicts = data.conflicts.filter((c) => c.assignmentId === assignmentId);
  const [mode, setMode] = useState<"view" | "entry">(sheet ? "view" : "entry");
  const [handoff, setHandoff] = useState("");
  const [decodeError, setDecodeError] = useState("");
  if (!a) return null;
  return (
    <section className="org-panel" aria-label="Sheet detail">
      <div className="org-actions justify-between">
        <h2>
          {a.display.judgeName} · {a.display.roomName}
        </h2>
        <button className="org-button" onClick={onClose}>
          Close sheet
        </button>
      </div>
      <p className="org-muted">
        Round {a.identity.round} · {a.display.government.code} v {a.display.opposition.code}
        {sheet ? ` · version ${sheet.version} · ${sheet.source}` : " · not yet received"}
      </p>
      {sheet && mode === "view" && (
        <>
          <ScoresSummary data={data} payload={sheet} />
          <button className="org-button" onClick={() => setMode("entry")}>
            Correct scores
          </button>
        </>
      )}
      {mode === "entry" && a.live && (
        <ActionForm
          command={command}
          action={sheet ? "sheet.correct" : "sheet.paper"}
          primary
          label={sheet ? "Save correction" : "Receive paper sheet"}
          make={(f) => ({
            assignmentId: a.id,
            ...(sheet ? { baseVersion: sheet.version } : { judgeNameConfirmed: true }),
            payload: scorePayload(f, a),
            reason: text(f, "reason"),
          })}
          onSuccess={() => setMode("view")}
        >
          <p>Check the judge’s name and all four debaters against the paper sheet.</p>
          <Check
            name="sideFlipped"
            label="Government and Opposition swapped after the coin toss"
            checked={sheet?.sideFlipped}
          />
          {[a.display.government, a.display.opposition].map((t) => (
            <Check
              key={t.teamId}
              name={`swap.${t.teamId}`}
              label={`${t.code}: the two debaters swapped roles`}
              checked={sheet?.roleSwaps[t.teamId]}
            />
          ))}
          {a.display.speakers.map((s) => (
            <fieldset key={s.id} className="org-panel">
              <legend className="font-display text-xl">
                {s.role.toUpperCase()} · {s.name}
              </legend>
              <div className="org-sheet-scores">
                {data.tournament.settings.rubric.categories.map((cat) => (
                  <Field
                    key={cat.key}
                    name={`${s.id}.${cat.key}`}
                    label={`${cat.label} / ${cat.max}`}
                    type="number"
                    min={0}
                    max={cat.max}
                    required
                    value={sheet?.scores[s.id]?.[cat.key]}
                  />
                ))}
                <Field
                  name={`${s.id}.overall`}
                  label={`Overall / ${data.tournament.settings.rubric.overallMax}`}
                  type="number"
                  min={0}
                  max={data.tournament.settings.rubric.overallMax}
                  required
                  value={sheet?.scores[s.id]?.overall}
                />
              </div>
              <Field
                name={`${s.id}.www`}
                label="What went well"
                type="textarea"
                value={sheet?.scores[s.id]?.www}
              />
              <Field
                name={`${s.id}.ebi`}
                label="Even better if"
                type="textarea"
                value={sheet?.scores[s.id]?.ebi}
              />
            </fieldset>
          ))}
          <Reason />
          <label className="org-check">
            <input type="checkbox" required />I have checked the judge’s name: {a.display.judgeName}
          </label>
        </ActionForm>
      )}
      {conflicts.map((conflict) => (
        <section key={conflict.id}>
          <h3>Two versions to review</h3>
          <div className="org-payload-compare">
            <div>
              <h4>Current received sheet</h4>
              {sheet && <ScoresSummary data={data} payload={sheet} />}
            </div>
            <div>
              <h4>Incoming sheet</h4>
              <ScoresSummary data={data} payload={conflict.incoming} />
            </div>
          </div>
          <ActionForm
            command={command}
            action="sheet.resolve"
            label="Record decision"
            make={(f) => ({
              conflictId: conflict.id,
              choice: text(f, "choice"),
              reason: text(f, "reason"),
            })}
          >
            <Field name="choice" label="Version decision">
              <option value="keep">Keep current sheet</option>
              <option value="incoming">Use incoming sheet</option>
              {conflict.kind === "comments_only" && (
                <option value="merge_comments">Keep scores and merge incoming comments</option>
              )}
            </Field>
            <Reason />
          </ActionForm>
        </section>
      ))}
      {a.live && !sheet && (
        <details>
          <summary>Mark as won’t arrive</summary>
          <ActionForm
            command={command}
            action="sheet.waive"
            label="Mark as won’t arrive"
            make={(f) => ({ assignmentId: a.id, reason: text(f, "reason") })}
          >
            <p>The missing sheet remains visible and is excluded from the publishing blockers.</p>
            <Reason />
          </ActionForm>
        </details>
      )}
      {a.live && (
        <details>
          <summary>Enter a phone hand-off</summary>
          <p className="org-muted">
            Choose a QR image or photo, or paste the full checked hand-off text from the judge’s
            phone. It carries scores and sides; comments can arrive separately.
          </p>
          <HandoffScanner
            onDecoded={(value) => {
              setHandoff(value);
              setDecodeError("");
            }}
          />
          <label className="org-field">
            Hand-off text
            <textarea value={handoff} onChange={(e) => setHandoff(e.target.value)} />
          </label>
          <ActionForm
            command={command}
            action="sheet.handoff"
            label="Receive hand-off"
            make={(f) => {
              try {
                const decoded = decodeHandoff(handoff);
                if (decoded.assignmentId !== a.id || decoded.judgeId !== a.judgeId)
                  throw new Error(
                    "This hand-off belongs to a different judge or sheet. Open that sheet first.",
                  );
                setDecodeError("");
                return {
                  assignmentId: a.id,
                  judgeId: a.judgeId,
                  requestId: decoded.requestId,
                  payload: decoded.payload,
                  reason: text(f, "reason"),
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : "Check the hand-off text.";
                setDecodeError(message);
                return {
                  assignmentId: a.id,
                  judgeId: a.judgeId,
                  requestId: "",
                  payload: null,
                  reason: text(f, "reason"),
                };
              }
            }}
          >
            <Reason />
          </ActionForm>
          {decodeError && (
            <div role="alert" className="org-error">
              {decodeError}
            </div>
          )}
        </details>
      )}
    </section>
  );
}
export function LivePage({ data, round, roomId }: { data: Data; round: number; roomId?: string }) {
  const c = useCommand(data.tournament.id);
  const router = useRouter();
  const initial = data.boards.find((b) => b.round === round);
  const [polled, setBoard] = useState<LiveBoard | undefined>();
  const board = polled && initial && polled.generatedAt > initial.generatedAt ? polled : initial;
  const [selected, setSelected] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let signature = JSON.stringify(initial);
    const poll = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await fetch(`/api/t/${data.tournament.id}/live?round=${round}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error();
        const result = (await response.json()) as { ok: boolean; data: LiveBoard };
        if (!stopped && result.ok) {
          setBoard(result.data);
          setOffline(false);
          const next = JSON.stringify({ ...result.data, generatedAt: "" });
          if (signature !== next) {
            signature = next;
            router.refresh();
          }
        }
      } catch {
        if (!stopped) setOffline(true);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [data.tournament.id, round, initial, router]);
  if (!board) return <PageHeader title="Round not found" />;
  const rooms = board.rooms.filter((r) => !roomId || r.roomId === roomId);
  return (
    <>
      <PageHeader
        eyebrow="Live · refreshes every 5 seconds"
        title={`Round ${round}`}
        subtitle={`${board.roundStatus}. Closing a round still accepts late sheets; published results prevent score changes.`}
      />
      {offline && (
        <Banner kind="offline">
          The live board could not refresh. Showing the last received state.
        </Banner>
      )}
      {c.feedback}
      <div className="org-round-links">
        {data.boards.map((b) => (
          <Link
            key={b.round}
            href={`/t/${data.tournament.slug}/rounds/${b.round}` as Route}
            className="org-button"
            aria-current={b.round === round ? "page" : undefined}
          >
            Round {b.round}
          </Link>
        ))}
      </div>
      <div className="org-grid mt-6">
        <NowCard
          label="Sheets received"
          value={board.counts.received}
          max={board.counts.expected}
          detail={`${board.counts.twoVersions} two versions · ${board.counts.needsAttention} need attention`}
        />
        <section className="org-panel">
          <h2>Round controls</h2>
          <div className="org-actions">
            {board.roundStatus !== "open" && (
              <button
                className="org-button primary"
                onClick={() => c.execute("round.open", { round })}
              >
                Open round {round}
              </button>
            )}
            {board.roundStatus === "open" && (
              <button className="org-button" onClick={() => c.execute("round.close", { round })}>
                Close round softly
              </button>
            )}
          </div>
          {board.roundStatus === "closed" && (
            <ActionForm
              command={c}
              action="round.reopen"
              label="Reopen round"
              make={(f) => ({ round, reason: text(f, "reason") })}
            >
              <Reason />
            </ActionForm>
          )}
          <details>
            <summary>Set the motion</summary>
            <ActionForm
              command={c}
              action="round.motion"
              make={(f) => ({
                round,
                divisionCode: text(f, "divisionCode"),
                motion: text(f, "motion"),
                expectedRevision: data.draw.revision,
              })}
            >
              <Field name="divisionCode" label="Division">
                {data.tournament.settings.divisions.map((d) => (
                  <option key={d.code}>{d.code}</option>
                ))}
              </Field>
              <Field name="motion" label="Motion" type="textarea" required />
            </ActionForm>
          </details>
        </section>
      </div>
      <Table
        caption="Select a judge seat to receive, correct or review a sheet"
        heads={[
          "Room / debate",
          ...Array.from(
            { length: data.tournament.settings.judgesPerRoom },
            (_, i) => `Judge ${i + 1}`,
          ),
        ]}
      >
        {rooms.map((r) => (
          <tr key={r.roomId}>
            <th scope="row">
              <Link href={`/t/${data.tournament.slug}/rounds/${round}?room=${r.roomId}` as Route}>
                {r.name}
              </Link>
              <p>
                {r.debate.governmentTeam.code} v {r.debate.oppositionTeam.code}
              </p>
              <p className="org-muted">{r.debate.motion}</p>
              {r.debate.disputed && <StatusChip variant="danger">Sides need attention</StatusChip>}
            </th>
            {r.seats.map((s) => (
              <td key={s.judgeId}>
                <button
                  className="org-button text-left w-full"
                  onClick={() => setSelected(s.assignmentId)}
                  disabled={!s.assignmentId}
                >
                  <span className="block">{s.judgeName}</span>
                  <StatusChip
                    variant={
                      s.version
                        ? "success"
                        : ["two-versions", "missing", "needs-attention"].includes(s.state)
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {labels[s.state]}
                  </StatusChip>
                  {s.filled !== undefined && (
                    <span className="block org-muted">{s.filled} fields filled</span>
                  )}
                </button>
                {s.state === "waived" && s.assignmentId && (
                  <details>
                    <summary>Expect this sheet again</summary>
                    <ActionForm
                      command={c}
                      action="sheet.unwaive"
                      make={(f) => ({ assignmentId: s.assignmentId, reason: text(f, "reason") })}
                    >
                      <Reason />
                    </ActionForm>
                  </details>
                )}
              </td>
            ))}
          </tr>
        ))}
      </Table>
      {roomId && (
        <Link href={`/t/${data.tournament.slug}/rounds/${round}` as Route}>All rooms</Link>
      )}
      {selected && (
        <SheetDrawer
          key={`${selected}:${data.sheets.find((s) => s.assignmentId === selected)?.version ?? 0}`}
          data={data}
          assignmentId={selected}
          command={c}
          onClose={() => setSelected(null)}
        />
      )}
      <section className="org-panel">
        <h2>Unmatched sheets</h2>
        {board.orphaned.length ? (
          board.orphaned.map((o) => (
            <details key={o.assignmentId}>
              <summary>
                {o.judgeName} · {o.roomName} · old draw version {o.version}
              </summary>
              <p>{o.retiredReason ?? "The draw changed after this sheet arrived."}</p>
              <p className="org-muted">
                Original scores remain in the history.{" "}
                {o.speakersUnchanged
                  ? "The successor has the same debaters."
                  : "Debaters changed; do not carry scores to different people."}
              </p>
              <button className="org-button" onClick={() => setSelected(o.assignmentId)}>
                View original sheet
              </button>
              {o.successorId && o.speakersUnchanged && (
                <ActionForm
                  command={c}
                  action="sheet.attach"
                  label="Attach to compatible successor"
                  make={(f) => ({
                    assignmentId: o.assignmentId,
                    successorId: o.successorId,
                    speakerMap: Object.fromEntries(
                      data.assignments
                        .find((a) => a.id === o.assignmentId)
                        ?.identity.speakers.map((s) => [s.id, s.id]) ?? [],
                    ),
                    reason: text(f, "reason"),
                  })}
                >
                  <p className="org-muted">
                    This carries forward the currently received scores. Any competing old version
                    stays in history and is set aside by this decision.
                  </p>
                  <Reason />
                </ActionForm>
              )}
              <ActionForm
                command={c}
                action="sheet.discard"
                label="Set this old sheet aside"
                make={(f) => ({ assignmentId: o.assignmentId, reason: text(f, "reason") })}
              >
                <Reason />
              </ActionForm>
            </details>
          ))
        ) : (
          <p className="org-muted">Every received sheet matches the current draw.</p>
        )}
      </section>
      {data.tournament.kind !== "live" && (
        <section className="org-panel">
          <h2>Practice this round</h2>
          <div className="org-actions">
            {rooms.map((r) => (
              <button
                key={r.roomId}
                className="org-button"
                onClick={() => c.execute("simulation.room", { roomId: r.roomId, round })}
              >
                Simulate {r.name}
              </button>
            ))}
            {selected && (
              <button
                className="org-button"
                onClick={() => c.execute("simulation.conflict", { assignmentId: selected })}
              >
                Introduce two versions
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
