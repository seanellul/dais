"use client";
import { useState, useTransition } from "react";
import { PageHeader } from "@/ui";
import { describePolicy } from "@/domain/scoring";
import { createInviteAction } from "@/server/actions/auth";
import { ActionForm, Check, Field, Reason, number, text, useCommand, type Data } from "./controls";
import { DemoControls } from "./run-sheet";
export function SettingsPage({ data }: { data: Data }) {
  const c = useCommand(data.tournament.id);
  const s = data.tournament.settings;
  const policy = data.results[0].policy;
  const [invite, setInvite] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [pending, start] = useTransition();
  const [multiplier, setMultiplier] = useState(policy.sdMultiplier);
  return (
    <>
      <PageHeader
        title="Tournament settings"
        subtitle="Clear rules make a calm tournament. Published divisions must be reopened before scoring rules change."
      />
      {c.feedback}
      <div className="org-grid">
        <section className="org-panel">
          <h2>Details</h2>
          <ActionForm
            command={c}
            action="tournament.update"
            make={(f) => ({ name: text(f, "name"), slug: text(f, "slug") })}
          >
            <Field name="name" label="Tournament name" required value={data.tournament.name} />
            <Field name="slug" label="Short link" required value={data.tournament.slug} />
          </ActionForm>
          <h3 className="mt-6">On the day</h3>
          <ActionForm
            command={c}
            action="settings.update"
            make={(f) => ({
              expectedRevision: data.draw.revision,
              patch: {
                contact: text(f, "contact"),
                eventDate: text(f, "eventDate"),
                venue: text(f, "venue"),
                feedbackRequired: f.has("feedbackRequired"),
              },
            })}
          >
            <Field name="eventDate" label="Event date" type="date" value={s.eventDate} />
            <Field name="venue" label="Venue" value={s.venue} />
            <Field name="contact" label="Organiser contact shown to judges" value={s.contact} />
            <Check
              name="feedbackRequired"
              label="Require written feedback"
              checked={s.feedbackRequired}
            />
          </ActionForm>
        </section>
        <section className="org-panel">
          <h2>Public page</h2>
          <p className="org-muted">
            The schedule can be shared publicly. Results appear after publication unless you
            explicitly allow provisional results.
          </p>
          <ActionForm
            command={c}
            action="settings.update"
            make={(f) => ({
              expectedRevision: data.draw.revision,
              patch: {
                publicPage: {
                  enabled: f.has("enabled"),
                  showProvisional: f.has("showProvisional"),
                },
              },
            })}
          >
            <Check
              name="enabled"
              label="Enable public tournament page"
              checked={s.publicPage?.enabled}
            />
            <Check
              name="showProvisional"
              label="Also show provisional results"
              checked={s.publicPage?.showProvisional}
            />
          </ActionForm>
          {s.publicPage?.enabled && (
            <a
              href={`/p/${data.tournament.slug}--${data.tournament.id}`}
              className="org-button mt-4 inline-flex"
            >
              Open public page
            </a>
          )}
        </section>
      </div>
      <section className="org-panel">
        <h2>Outlier policy</h2>
        <p>{describePolicy({ ...policy, sdMultiplier: multiplier })}</p>
        <ActionForm
          command={c}
          action="settings.policy"
          label="Save scoring policy"
          make={(f) => ({
            policy: {
              sdMultiplier: number(f, "sdMultiplier"),
              bounds: text(f, "bounds"),
              scope: text(f, "scope"),
              passes: text(f, "passes"),
              sd: text(f, "sd"),
              whenUndefined: text(f, "whenUndefined"),
              zeroSpread: text(f, "zeroSpread"),
              excelCriteriaRounding: f.has("excelCriteriaRounding"),
            },
            reason: text(f, "reason"),
          })}
        >
          <label className="org-field">
            Kept-range width in spreads
            <input
              name="sdMultiplier"
              type="number"
              min={0}
              max={100}
              step="0.1"
              required
              value={multiplier}
              onChange={(e) => setMultiplier(Number(e.target.value))}
            />
          </label>
          <div className="org-grid">
            <Field name="bounds" label="Scores exactly on an edge" value={policy.bounds}>
              <option value="strict">Set aside</option>
              <option value="inclusive">Keep</option>
            </Field>
            <Field name="scope" label="Build the kept range" value={policy.scope}>
              <option value="pooled">Across all rounds</option>
              <option value="perRound">Separately per round</option>
            </Field>
            <Field name="passes" label="Checks" value={policy.passes}>
              <option value="one">One pass</option>
              <option value="iterative">Repeat until stable</option>
            </Field>
            <Field name="sd" label="Spread calculation" value={policy.sd}>
              <option value="sample">Sample (workbook)</option>
              <option value="population">Population</option>
            </Field>
            {["whenUndefined", "zeroSpread"].map((k) => (
              <Field
                key={k}
                name={k}
                label={k === "whenUndefined" ? "Fewer than two scores" : "All scores identical"}
                value={policy[k as "whenUndefined" | "zeroSpread"]}
              >
                <option value="unresolved">Needs an organiser decision</option>
                <option value="keepAll">Keep all scores</option>
              </Field>
            ))}
          </div>
          <Check
            name="excelCriteriaRounding"
            label="Match workbook edge rounding"
            checked={policy.excelCriteriaRounding}
          />
          <Reason />
        </ActionForm>
      </section>
      <section className="org-panel">
        <h2>Judging rubric</h2>
        <ActionForm
          command={c}
          action="settings.update"
          label="Save rubric"
          make={(f) => ({
            expectedRevision: data.draw.revision,
            patch: {
              rubric: {
                ...s.rubric,
                categories: s.rubric.categories.map((cat) => ({
                  ...cat,
                  label: text(f, `${cat.key}.label`),
                  max: number(f, `${cat.key}.max`),
                })),
                overallMax: number(f, "overallMax"),
                noRebuttalScore: number(f, "noRebuttalScore"),
                commentMaxLength: number(f, "commentMaxLength"),
                integersOnly: f.has("integersOnly"),
                bands: s.rubric.bands.map((b, i) => ({
                  ...b,
                  min: number(f, `band.${i}.min`),
                  max: number(f, `band.${i}.max`),
                  label: text(f, `band.${i}.label`),
                  summary: text(f, `band.${i}.summary`),
                })),
              },
            },
          })}
        >
          <div className="org-grid">
            {s.rubric.categories.map((cat) => (
              <fieldset key={cat.key}>
                <legend>{cat.label}</legend>
                <Field
                  name={`${cat.key}.label`}
                  label="Category label"
                  required
                  value={cat.label}
                />
                <Field
                  name={`${cat.key}.max`}
                  label="Maximum"
                  type="number"
                  min={1}
                  required
                  value={cat.max}
                />
              </fieldset>
            ))}
          </div>
          <div className="org-grid">
            <Field
              name="overallMax"
              label="Overall maximum"
              type="number"
              min={1}
              required
              value={s.rubric.overallMax}
            />
            <Field
              name="noRebuttalScore"
              label="No rebuttal attempted score"
              type="number"
              min={0}
              required
              value={s.rubric.noRebuttalScore}
            />
            <Field
              name="commentMaxLength"
              label="Comment length limit"
              type="number"
              min={1}
              required
              value={s.rubric.commentMaxLength}
            />
          </div>
          <Check
            name="integersOnly"
            label="Whole-number scores only"
            checked={s.rubric.integersOnly}
          />
          {s.rubric.bands.map((b, i) => (
            <details key={i}>
              <summary>
                {b.label}: {b.min}–{b.max}
              </summary>
              <div className="org-grid">
                <Field
                  name={`band.${i}.min`}
                  label="Lowest score"
                  type="number"
                  required
                  min={0}
                  value={b.min}
                />
                <Field
                  name={`band.${i}.max`}
                  label="Highest score"
                  type="number"
                  required
                  min={0}
                  value={b.max}
                />
              </div>
              <Field name={`band.${i}.label`} label="Band label" required value={b.label} />
              <Field
                name={`band.${i}.summary`}
                label="Judging guidance"
                type="textarea"
                value={b.summary}
              />
            </details>
          ))}
        </ActionForm>
      </section>
      {data.owner && data.tournament.kind !== "demo" && (
        <section className="org-panel">
          <h2>Invite an organiser</h2>
          <form
            className="org-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              start(async () => {
                const r = await createInviteAction({
                  organisationId: data.tournament.organisationId,
                  email: text(f, "email"),
                  role: text(f, "role"),
                });
                if (r.ok) {
                  setInvite(r.data.link);
                  setInviteError("");
                } else setInviteError(r.error.message);
              });
            }}
          >
            <Field name="email" label="Email address" type="email" required />
            <Field name="role" label="Role">
              <option value="organiser">Organiser</option>
              <option value="owner">Owner</option>
            </Field>
            <button className="org-button" disabled={pending}>
              Create invitation
            </button>
            {inviteError && (
              <div role="alert" className="org-error">
                {inviteError}
              </div>
            )}
            {invite && (
              <div>
                <p>Share this private invitation with that person:</p>
                <a href={invite}>{invite}</a>
              </div>
            )}
          </form>
        </section>
      )}
      <DemoControls data={data} />
      <section className="org-panel">
        <h2>Backup & archive</h2>
        <a className="org-button" href={`/api/t/${data.tournament.id}/export/backup`}>
          Download backup
        </a>
        {data.tournament.kind !== "demo" && (
          <>
            <details>
              <summary>Restore this tournament from a backup</summary>
              <ActionForm
                command={c}
                action="backup.restore"
                label="Restore backup"
                make={(f) => ({
                  backupText: text(f, "backupText"),
                  confirmSlug: text(f, "confirmSlug"),
                  reason: text(f, "reason"),
                })}
              >
                <Field name="backupText" label="Backup file contents" type="textarea" required />
                <Field
                  name="confirmSlug"
                  label={`Type ${data.tournament.slug} to replace tournament data`}
                  required
                />
                <Reason />
              </ActionForm>
            </details>
            <details>
              <summary>Archive tournament</summary>
              <ActionForm
                command={c}
                action="tournament.archive"
                label="Archive tournament"
                make={() => ({})}
              >
                <label className="org-check">
                  <input required type="checkbox" />I have saved the exports I need.
                </label>
              </ActionForm>
            </details>
          </>
        )}{" "}
      </section>
    </>
  );
}
