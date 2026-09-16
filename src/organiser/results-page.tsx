"use client";
import { useState } from "react";
import { Banner, PageHeader, StatusChip } from "@/ui";
import { ActionForm, Field, Reason, Table, date, text, useCommand, type Data } from "./controls";
export function ResultsPage({ data }: { data: Data }) {
  const c = useCommand(data.tournament.id);
  const [division, setDivision] = useState(data.results[0]?.divisionCode ?? "");
  const view = data.results.find((r) => r.divisionCode === division);
  if (!view) return null;
  const candidates = [...view.finalists.teams, ...(view.finalists.tieAtCut?.teams ?? [])].filter(
    (t, i, all) => all.findIndex((x) => x.id === t.id) === i,
  );
  return (
    <>
      <PageHeader
        eyebrow={view.published ? "Published results" : "Provisional results"}
        title="Results"
        subtitle="Every average has a trace. Every organiser decision has a reason."
      />
      {c.feedback}
      <div className="org-actions" role="group" aria-label="Division">
        {data.results.map((r) => (
          <button
            key={r.divisionCode}
            className="org-button"
            aria-pressed={r.divisionCode === division}
            onClick={() => setDivision(r.divisionCode)}
          >
            {r.divisionName}
          </button>
        ))}
      </div>
      {view.completeness.provisional && (
        <Banner kind="provisional">
          {view.completeness.missing.filter((m) => !m.waived).length} sheets are still missing.{" "}
          {view.completeness.blockers.join(" ")}
        </Banner>
      )}
      <section className="org-panel">
        <h2>Scoring policy</h2>
        <p>{view.policyText}</p>
        <p className="org-muted">
          {view.completeness.received} of {view.completeness.expected} sheets received ·{" "}
          {view.openConflicts} two-version cases · {view.completeness.orphaned.length} unmatched
          sheets
        </p>
        {view.completeness.missing.length > 0 && (
          <details>
            <summary>Missing sheets</summary>
            <ul>
              {view.completeness.missing.map((m) => (
                <li key={m.assignmentId}>
                  {m.judgeName} · {m.roomName} · round {m.round}
                  {m.waived ? ` · won’t arrive: ${m.waiverReason}` : " · waiting"}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <Table
        caption="Debaters — expand a name to see each judge’s scores"
        heads={[
          "Rank",
          "Debater / team",
          ...data.tournament.settings.rounds.map((r) => `Round ${r.number}`),
          "Total / decisions",
        ]}
      >
        {view.debaters.map((d) => (
          <tr key={d.id}>
            <td className="number">
              {d.rank ?? "—"}
              {d.tiedWith.length > 0 && " ="}
            </td>
            <th scope="row">
              <details>
                <summary>
                  <span className="font-display text-lg">{d.name}</span>
                  <span className="block org-muted">
                    {d.teamCode} · {d.school}
                  </span>
                </summary>
                {d.rounds.map((r) => (
                  <section key={r.round} className="py-3">
                    <h3>Round {r.round}</h3>
                    <p>
                      {r.scores.map((s) => `${s.judgeName} ${s.value} (${s.label})`).join(" · ")}
                    </p>
                    <p className="org-muted">
                      {r.reason ??
                        (r.average === null
                          ? "This round can’t be scored yet."
                          : `The kept scores average ${r.average.toFixed(2)}.`)}
                    </p>
                    {r.range && (
                      <p className="org-muted">
                        Average {r.range.average?.toFixed(2) ?? "—"} · spread{" "}
                        {r.range.spread?.toFixed(2) ?? "—"} · kept range{" "}
                        {r.range.lower?.toFixed(2) ?? "—"} to {r.range.upper?.toFixed(2) ?? "—"}
                      </p>
                    )}
                    {!view.published &&
                      r.scores.map((s) => (
                        <details key={s.assignmentId}>
                          <summary>
                            {s.judgeName}: keep or set aside {s.value}
                          </summary>
                          <ActionForm
                            command={c}
                            action="override.add"
                            label="Record score decision"
                            make={(f) => ({
                              divisionCode: division,
                              kind: text(f, "kind"),
                              speakerId: d.id,
                              round: r.round,
                              assignmentId: s.assignmentId,
                              reason: text(f, "reason"),
                            })}
                          >
                            <Field name="kind" label="Decision">
                              <option value="force_include">Keep this score</option>
                              <option value="force_exclude">Set this score aside</option>
                            </Field>
                            <Reason />
                          </ActionForm>
                        </details>
                      ))}
                  </section>
                ))}
              </details>
            </th>
            {d.rounds.map((r) => (
              <td className="number" key={r.round}>
                {r.average?.toFixed(2) ?? "—"}
              </td>
            ))}
            <td className="number">
              <strong>{d.total?.toFixed(2) ?? "—"}</strong>
              {d.statusWords !== "ready" && <p className="org-muted">{d.statusWords}</p>}
              {d.reasons.map((r, i) => (
                <p key={i} className="org-muted">
                  {r}
                </p>
              ))}
              {!view.published && (
                <details>
                  <summary>Debater decision</summary>
                  <ActionForm
                    command={c}
                    action="override.add"
                    label="Record decision"
                    make={(f) => ({
                      divisionCode: division,
                      kind: text(f, "kind"),
                      speakerId: d.id,
                      reason: text(f, "reason"),
                    })}
                  >
                    <Field name="kind" label="Decision">
                      <option value="keep_all_for_debater">
                        Keep all of this debater’s scores
                      </option>
                      <option value="exclude_debater">Exclude this debater from ranking</option>
                    </Field>
                    <Reason />
                  </ActionForm>
                </details>
              )}
              {d.overrides.map((o) => (
                <details key={o.id}>
                  <summary>Organiser decision: {o.kind.replaceAll("_", " ")}</summary>
                  <p>{o.reason}</p>
                  {!view.published && (
                    <ActionForm
                      command={c}
                      action="override.revoke"
                      label="Revoke decision"
                      make={(f) => ({ overrideId: o.id, reason: text(f, "reason") })}
                    >
                      <Reason />
                    </ActionForm>
                  )}
                </details>
              ))}
            </td>
          </tr>
        ))}
      </Table>
      <h2>Teams</h2>
      <Table
        caption="Team totals combine the two debaters"
        heads={["Rank", "Team", "Debaters", "Total"]}
      >
        {view.teams.map((t) => (
          <tr key={t.id}>
            <td className="number">
              {t.rank ?? "—"}
              {t.tiedWith.length > 0 && " ="}
            </td>
            <th scope="row">
              {t.code} · {t.name}
              <p className="org-muted">{t.school}</p>
            </th>
            <td>
              {t.members.map((m) => (
                <p key={m.id}>
                  {m.name} · {m.total?.toFixed(2) ?? "—"}
                </p>
              ))}
            </td>
            <td className="number">{t.total?.toFixed(2) ?? t.statusWords}</td>
          </tr>
        ))}
      </Table>
      <section className="org-panel">
        <h2>Finalists</h2>
        {view.confirmation ? (
          <>
            <StatusChip variant="success">Confirmed</StatusChip>
            <p>
              {view.confirmation.teamIds
                .map((id) => view.teams.find((t) => t.id === id)?.code)
                .join(" and ")}
            </p>
            <p>{view.confirmation.reason}</p>
            <p className="org-muted">
              {view.confirmation.by} · {date(view.confirmation.at)}
            </p>
          </>
        ) : (
          <>
            <p>
              {view.finalists.teams.map((t) => t.code).join(" and ") ||
                "Finalists will appear once every team can be ranked."}
            </p>
            {view.finalists.tieAtCut && (
              <p>
                There is a tie at the finalist cut. Choose from the eligible tied teams and record
                the decision.
              </p>
            )}
            {!view.published && (
              <ActionForm
                command={c}
                action="results.finalists"
                label="Confirm finalists"
                make={(f) => ({
                  divisionCode: division,
                  teamIds: [text(f, "first"), text(f, "second")],
                  reason: text(f, "reason"),
                })}
              >
                {["first", "second"].map((k, i) => (
                  <Field key={k} name={k} label={`Finalist ${i + 1}`} value={candidates[i]?.id}>
                    {candidates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code} · {t.name}
                      </option>
                    ))}
                  </Field>
                ))}
                <Reason />
              </ActionForm>
            )}
          </>
        )}
      </section>
      <section className="org-panel">
        <h2>{view.published ? "Published" : "Publish results"}</h2>
        {view.published ? (
          <>
            <p>
              Published {date(view.published.at)}. Score changes require reopening this division.
            </p>
            <ActionForm
              command={c}
              action="results.reopen"
              label="Reopen results"
              make={(f) => ({ divisionCode: division, reason: text(f, "reason") })}
            >
              <Reason />
            </ActionForm>
          </>
        ) : (
          <>
            <ul className="list-disc pl-5">
              {view.completeness.blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
            <ActionForm
              command={c}
              action="results.publish"
              primary
              label={`Publish ${view.divisionName} results`}
              make={() => ({ divisionCode: division, acknowledgePolicy: true })}
            >
              <label className="org-check">
                <input type="checkbox" required />I have reviewed the policy, missing sheets, ties
                and organiser decisions.
              </label>
            </ActionForm>
          </>
        )}
      </section>
    </>
  );
}
