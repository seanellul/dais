"use client";
import { useState } from "react";
import { PageHeader, StatusChip } from "@/ui";
import type { Debate } from "@/domain/types";
import {
  ActionForm,
  Check,
  Field,
  Reason,
  Table,
  human,
  number,
  record,
  text,
  useCommand,
  type Data,
} from "./controls";
export function DrawPage({ data }: { data: Data }) {
  const c = useCommand(data.tournament.id);
  const [preview, setPreview] = useState<{
    baseRevision: number;
    debates: Debate[];
    seed: string;
    warnings: unknown[];
    issues: unknown[];
  } | null>(null);
  const [round, setRound] = useState(1);
  const [division, setDivision] = useState("all");
  const [protectedEdit, setProtectedEdit] = useState<string | null>(null);
  const candidates = preview?.debates ?? data.debates;
  const rows = candidates.filter(
    (d) => d.round === round && (division === "all" || d.divisionCode === division),
  );
  const name = (id: string) => data.teams.find((t) => t.id === id)?.code ?? "Unknown team";
  return (
    <>
      <PageHeader
        title="The draw"
        subtitle={`Revision ${data.draw.revision}. ${data.draw.status.replaceAll("-", " ")}. Panels stay in their rooms unless you choose otherwise.`}
      />
      {c.feedback}
      <section className="org-panel">
        <h2>Generate a preview</h2>
        <ActionForm
          command={c}
          action="draw.preview"
          label="Generate draw preview"
          primary
          make={(f) => ({
            divisionCodes: f.getAll("division").map(String),
            seed: text(f, "seed") || undefined,
            method: text(f, "method"),
          })}
          onSuccess={(v) => {
            const r = record(v);
            if (Array.isArray(r.debates))
              setPreview({
                baseRevision: data.draw.revision,
                debates: r.debates as Debate[],
                seed: String(r.seed),
                warnings: Array.isArray(r.warnings) ? r.warnings : [],
                issues: Array.isArray(r.issues) ? r.issues : [],
              });
          }}
        >
          <div className="org-actions">
            {data.tournament.settings.divisions.map((d) => (
              <label key={d.code} className="org-check">
                <input type="checkbox" name="division" value={d.code} defaultChecked />
                {d.name}
              </label>
            ))}
          </div>
          <div className="org-grid">
            <Field name="seed" label="Visible random seed (optional)" />
            <Field name="method" label="Team order" value="random">
              <option value="random">Random by team code</option>
              <option value="seeded">Use team seeds</option>
            </Field>
          </div>
        </ActionForm>
        {preview && (
          <>
            <p className="mt-4">
              <strong>Preview seed:</strong> {preview.seed}
            </p>
            {[...preview.warnings, ...preview.issues].map((issue, i) => (
              <p key={i} className="org-muted">
                {human(issue)}
              </p>
            ))}
            <ActionForm
              command={c}
              action="draw.save"
              primary
              label="Save this preview"
              make={(f) => ({
                baseRevision: preview.baseRevision,
                debates: preview.debates,
                seed: preview.seed,
                allowOrphans: f.has("allowOrphans"),
                reason: text(f, "reason") || undefined,
              })}
              onSuccess={() => setPreview(null)}
            >
              {data.sheets.length > 0 && (
                <>
                  <Check
                    name="allowOrphans"
                    label="I understand affected received sheets will belong to the old draw"
                  />
                  <Reason />
                </>
              )}
            </ActionForm>
            <button className="org-button mt-2" onClick={() => setPreview(null)}>
              Discard preview
            </button>
          </>
        )}
      </section>
      <div className="org-actions">
        <label className="org-field">
          Round
          <select value={round} onChange={(e) => setRound(Number(e.target.value))}>
            {data.boards.map((b) => (
              <option key={b.round} value={b.round}>
                Round {b.round}
              </option>
            ))}
          </select>
        </label>
        <label className="org-field">
          Division
          <select value={division} onChange={(e) => setDivision(e.target.value)}>
            <option value="all">Both divisions</option>
            {data.tournament.settings.divisions.map((d) => (
              <option key={d.code}>{d.code}</option>
            ))}
          </select>
        </label>
      </div>
      <Table
        caption={
          preview
            ? "Unsaved preview — review before saving"
            : "Current draw — protect sheets already received"
        }
        heads={["Room / division", "Government", "Opposition", "Panel / motion", "Edit"]}
      >
        {rows.map((d) => {
          const assignments = data.assignments.filter((a) => a.live && a.debateId === d.id);
          const received = data.sheets.filter((s) =>
            assignments.some((a) => a.id === s.assignmentId),
          );
          return (
            <tr key={d.id}>
              <th scope="row">
                {data.rooms.find((r) => r.id === d.roomId)?.name}
                <p className="org-muted">{d.divisionCode}</p>
                {received.length > 0 && (
                  <StatusChip variant="warning">
                    {received.length} received sheets protected
                  </StatusChip>
                )}
              </th>
              <td>{name(d.governmentTeamId)}</td>
              <td>{name(d.oppositionTeamId)}</td>
              <td>
                {d.judgeIds.map((id) => data.judges.find((j) => j.id === id)?.name).join(" · ")}
                <p className="org-muted">{d.motion || "Motion to be announced"}</p>
              </td>
              <td>
                {!preview && (
                  <details>
                    <summary>Edit debate</summary>
                    <ActionForm
                      command={c}
                      action="draw.edit"
                      make={(f) => ({
                        baseRevision: data.draw.revision,
                        debateId: d.id,
                        patch: {
                          roomId: text(f, "roomId"),
                          governmentTeamId: text(f, "governmentTeamId"),
                          oppositionTeamId: text(f, "oppositionTeamId"),
                          judgeIds: f.getAll("judgeId").map(String),
                          motion: text(f, "motion"),
                        },
                        allowOrphans: f.has("allowOrphans"),
                        reason: text(f, "reason") || undefined,
                      })}
                    >
                      <Field name="roomId" label="Room" value={d.roomId}>
                        {data.rooms.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </Field>
                      {["governmentTeamId", "oppositionTeamId"].map((k) => (
                        <Field
                          key={k}
                          name={k}
                          label={k === "governmentTeamId" ? "Government team" : "Opposition team"}
                          value={k === "governmentTeamId" ? d.governmentTeamId : d.oppositionTeamId}
                        >
                          {data.teams
                            .filter(
                              (t) => t.divisionCode === d.divisionCode && t.status === "active",
                            )
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.code} · {t.name}
                              </option>
                            ))}
                        </Field>
                      ))}
                      <fieldset>
                        <legend>Judge seats</legend>
                        {data.judges
                          .filter((j) => j.status === "active")
                          .map((j) => (
                            <label className="org-check" key={j.id}>
                              <input
                                type="checkbox"
                                name="judgeId"
                                value={j.id}
                                defaultChecked={d.judgeIds.includes(j.id)}
                              />
                              {j.name}
                            </label>
                          ))}
                      </fieldset>
                      <Field name="motion" label="Motion" type="textarea" value={d.motion} />
                      {received.length > 0 && (
                        <>
                          <button
                            type="button"
                            className="org-button"
                            onClick={() => setProtectedEdit(d.id)}
                          >
                            Review protection
                          </button>
                          {protectedEdit === d.id && (
                            <p className="org-muted">
                              Changing either team or judge seats retires affected sheet slots.
                              Their original scores stay in the history and need an explicit
                              unmatched-sheet decision. Moving this debate to another room or
                              editing its motion preserves received sheets.
                            </p>
                          )}
                          <Check
                            name="allowOrphans"
                            label="Allow affected sheets to move to the unmatched tray"
                          />
                          <Reason />
                        </>
                      )}
                    </ActionForm>
                  </details>
                )}
              </td>
            </tr>
          );
        })}
      </Table>
      <section className="org-panel">
        <h2>Swap two teams</h2>
        <ActionForm
          command={c}
          action="draw.swap"
          label="Swap teams"
          make={(f) => ({
            baseRevision: data.draw.revision,
            round: number(f, "round"),
            teamId: text(f, "teamId"),
            otherTeamId: text(f, "otherTeamId"),
            allowOrphans: f.has("allowOrphans"),
            reason: text(f, "reason") || undefined,
          })}
        >
          <Field name="round" label="Round" value={round}>
            {data.boards.map((b) => (
              <option key={b.round} value={b.round}>
                {b.round}
              </option>
            ))}
          </Field>
          {["teamId", "otherTeamId"].map((k, i) => (
            <Field name={k} key={k} label={i ? "Other team" : "First team"}>
              {data.teams
                .filter((t) => t.status === "active")
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.divisionCode} · {t.code}
                  </option>
                ))}
            </Field>
          ))}
          {data.sheets.length > 0 && (
            <>
              <Check
                name="allowOrphans"
                label="Allow affected received sheets into the unmatched tray"
              />
              <Reason />
            </>
          )}
        </ActionForm>
      </section>
      <section className="org-panel">
        <h2>Publish the draw</h2>
        <p className="org-muted">
          Dais checks rooms, panels, repeated opponents and every team’s place before publishing.
          Judges then see this revision.
        </p>
        <ActionForm
          command={c}
          action="draw.publish"
          primary
          label="Publish draw"
          make={() => ({ baseRevision: data.draw.revision })}
        />
      </section>
    </>
  );
}
