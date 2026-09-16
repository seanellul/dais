"use client";
import Link from "next/link";
import type { Route } from "next";
import { Banner, NowCard, PageHeader, StepRow } from "@/ui";
import { ActionForm, Field, Reason, date, number, text, useCommand, type Data } from "./controls";
export function stepPath(slug: string, key: string) {
  return `/t/${slug}/${key.startsWith("round") ? `rounds/${key.slice(5)}` : key}` as Route;
}
export function Activity({ data, limit = 8 }: { data: Data; limit?: number }) {
  return (
    <ol className="org-timeline">
      {data.activity.slice(0, limit).map((a) => (
        <li key={a.id}>
          <p>
            <strong>{a.actorName ?? "Tournament"}</strong> ·{" "}
            {a.action.replaceAll(".", " ").replaceAll("_", " ")}
          </p>
          {a.reason && <p>{a.reason}</p>}
          <p className="org-muted">{date(a.at)}</p>
        </li>
      ))}
    </ol>
  );
}
export function DemoControls({ data }: { data: Data }) {
  const c = useCommand(data.tournament.id);
  if (data.tournament.kind === "live") return null;
  return (
    <section className="org-panel">
      <h2>Practice the day</h2>
      <p className="org-muted">
        These fictional scores help you practise receiving sheets and resolving two versions.
      </p>
      {c.feedback}
      <div className="org-grid">
        <ActionForm
          command={c}
          action="simulation.round"
          label="Simulate round"
          make={(f) => ({ round: number(f, "round"), leaveMissing: number(f, "leaveMissing") })}
        >
          <Field name="round" label="Round" value={1}>
            {data.boards.map((b) => (
              <option key={b.round} value={b.round}>
                Round {b.round}
              </option>
            ))}
          </Field>
          <Field
            name="leaveMissing"
            label="Sheets to leave missing"
            type="number"
            min={0}
            value={0}
          />
        </ActionForm>
        <ActionForm
          command={c}
          action="simulation.skip"
          label="Skip ahead to results"
          make={() => ({ to: "results" })}
        >
          <p>Receive the remaining sheets in one step.</p>
        </ActionForm>
        {data.owner && (
          <ActionForm
            command={c}
            action="simulation.reset"
            label="Reset simulated scores"
            make={() => ({})}
          >
            <p>Start scoring this practice draw again.</p>
          </ActionForm>
        )}
      </div>
    </section>
  );
}
export function Dashboard({ data }: { data: Data }) {
  const c = useCommand(data.tournament.id);
  const current =
    data.boards.find((b) => b.roundStatus === "open") ??
    data.boards.find((b) => b.counts.received < b.counts.expected) ??
    data.boards.at(-1);
  const next = data.checklist.steps.find((s) => s.key === data.checklist.next);
  return (
    <>
      {data.tournament.kind !== "live" && (
        <Banner kind="sandbox">Practice tournament · fictional teams and scores</Banner>
      )}
      <PageHeader
        eyebrow="Order of the day"
        title={data.tournament.name}
        subtitle="One clear next step. Every decision kept in the history."
        actions={
          next ? (
            <Link href={stepPath(data.tournament.slug, next.key)} className="org-button primary">
              {next.title}
            </Link>
          ) : (
            <Link
              href={`/t/${data.tournament.slug}/results` as Route}
              className="org-button primary"
            >
              View results
            </Link>
          )
        }
      />
      {c.feedback}
      <div className="org-grid">
        <section>
          <h2>The run sheet</h2>
          <ol>
            {data.checklist.steps.map((s, i) => (
              <StepRow
                key={s.key}
                number={i + 1}
                title={s.title}
                summary={s.summary}
                status={
                  s.state === "done"
                    ? "done"
                    : s.state === "needs-attention"
                      ? "attention"
                      : s.key === data.checklist.next
                        ? "current"
                        : "todo"
                }
                statusLabel={s.state.replaceAll("-", " ")}
                action={
                  <Link href={stepPath(data.tournament.slug, s.key)} className="org-button">
                    Open
                  </Link>
                }
                overflow={
                  <details>
                    <summary>Mark done anyway</summary>
                    <ActionForm
                      command={c}
                      action="checklist.override"
                      make={(f) => ({
                        step: s.key,
                        state: text(f, "state") || null,
                        reason: text(f, "reason"),
                      })}
                    >
                      <Field name="state" label="Checklist decision">
                        <option value="done">Mark done</option>
                        <option value="skipped">Skip step</option>
                        <option value="">Remove override</option>
                      </Field>
                      <Reason />
                    </ActionForm>
                  </details>
                }
              />
            ))}
          </ol>
        </section>
        <aside>
          {current && (
            <>
              <NowCard
                label={`Round ${current.round} · sheets received`}
                value={current.counts.received}
                max={current.counts.expected}
                detail={`${current.counts.needsAttention} need attention · ${current.roundStatus}`}
                progressLabel="Sheets received"
              />
              <section className="org-panel">
                <h2>Room progress</h2>
                {current.rooms.map((r) => (
                  <p key={r.roomId} className="py-2 border-b border-border">
                    <Link
                      href={
                        `/t/${data.tournament.slug}/rounds/${current.round}?room=${r.roomId}` as Route
                      }
                    >
                      {r.name}
                    </Link>{" "}
                    <span className="float-right tabular-nums">
                      {r.seats.filter((s) => s.version !== undefined).length} / {r.seats.length}
                    </span>
                  </p>
                ))}
                <Link
                  href={`/t/${data.tournament.slug}/rounds/${current.round}` as Route}
                  className="org-button mt-4 inline-flex"
                >
                  Open live board
                </Link>
              </section>
            </>
          )}
          <h2>Latest activity</h2>
          <Activity data={data} />
          <Link href={`/t/${data.tournament.slug}/history` as Route}>Full history</Link>
        </aside>
      </div>
      <DemoControls data={data} />
    </>
  );
}
