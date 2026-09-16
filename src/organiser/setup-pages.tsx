"use client";
import { useState } from "react";
import type { ParsedTeamList } from "@/domain/import/parse-team-list";
import Image from "next/image";
import QRCode from "qrcode";
import { PageHeader, StatusChip } from "@/ui";
import {
  ActionForm,
  Field,
  Reason,
  Table,
  number,
  record,
  text,
  useCommand,
  type Data,
} from "./controls";
function DivisionOptions({ data }: { data: Data }) {
  return (
    <>
      {data.tournament.settings.divisions.map((d) => (
        <option key={d.code} value={d.code}>
          {d.name}
        </option>
      ))}
    </>
  );
}
function TeamFields({ team }: { team?: Data["teams"][number] }) {
  return (
    <>
      <Field name="name" label="Team name" required value={team?.name} />
      <Field name="school" label="School" required value={team?.school} />
      <Field
        name="code"
        label="Team code"
        value={team?.code}
        help="Leave blank when adding to get the next division code."
      />
      <Field
        name="seed"
        label="Seed (optional)"
        type="number"
        min={0}
        value={team?.seed ?? undefined}
      />
      <Field
        name="first"
        label="First debater"
        required
        value={team?.speakers.find((s) => s.position === 1)?.name}
      />
      <Field
        name="second"
        label="Second debater"
        required
        value={team?.speakers.find((s) => s.position === 2)?.name}
      />
    </>
  );
}
const teamInput = (f: FormData) => ({
  name: text(f, "name"),
  school: text(f, "school"),
  code: text(f, "code") || undefined,
  seed: text(f, "seed") ? number(f, "seed") : null,
  speakers: [
    { position: 1, name: text(f, "first") },
    { position: 2, name: text(f, "second") },
  ],
});
export function TeamsPage({ data }: { data: Data }) {
  const c = useCommand(data.tournament.id);
  const [preview, setPreview] = useState<ParsedTeamList | null>(null);
  const [paste, setPaste] = useState("");
  const [division, setDivision] = useState(data.tournament.settings.divisions[0].code);
  return (
    <>
      <PageHeader
        title="Teams"
        subtitle="Two debaters per team. Keep the roster clear before making the draw."
      />
      {c.feedback}
      <div className="org-grid">
        <section className="org-panel">
          <h2>Add a team</h2>
          <ActionForm
            command={c}
            action="team.create"
            primary
            label="Add team"
            make={(f) => ({ ...teamInput(f), divisionCode: text(f, "divisionCode") })}
          >
            <Field name="divisionCode" label="Division">
              <DivisionOptions data={data} />
            </Field>
            <TeamFields />
          </ActionForm>
        </section>
        <section className="org-panel">
          <h2>Paste from a spreadsheet</h2>
          <p className="org-muted">
            Copy one row per debater with School, Debater and Team columns, plus an optional
            Division column. Two rows with the same school and team form a team.
          </p>
          <label className="org-field">
            Default division
            <select value={division} onChange={(e) => setDivision(e.target.value)}>
              <DivisionOptions data={data} />
            </select>
          </label>
          <label className="org-field mt-4">
            Spreadsheet rows
            <textarea
              value={paste}
              onChange={(e) => {
                setPaste(e.target.value);
                setPreview(null);
              }}
              rows={8}
            />
          </label>
          <button
            className="org-button mt-4"
            disabled={c.pending || !paste}
            onClick={() =>
              c.execute("team.import.preview", { text: paste, divisionCode: division }, (value) =>
                setPreview(value as ParsedTeamList),
              )
            }
          >
            Preview import
          </button>
          {preview !== null && (
            <div>
              <h3 className="mt-4">Import preview</h3>
              {preview.issues.map((issue, i) => (
                <p key={i}>
                  <StatusChip variant={issue.level === "error" ? "danger" : "warning"}>
                    Line {issue.row}: {issue.message}
                  </StatusChip>
                </p>
              ))}
              <Table
                caption={`${preview.teams.length} teams ready for review`}
                heads={["Code / division", "School / team", "Debaters"]}
              >
                {preview.teams.map((t) => (
                  <tr key={`${t.row}:${t.code}`}>
                    <th scope="row">
                      {t.code} · {t.divisionCode}
                    </th>
                    <td>
                      {t.school}
                      <p>{t.name}</p>
                    </td>
                    <td>
                      {t.speakers.map((s) => (
                        <p key={s.position}>
                          {s.position}. {s.name}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              </Table>
              <button
                className="org-button primary mt-4"
                disabled={c.pending || !preview.ok}
                onClick={() =>
                  c.execute("team.import.commit", { text: paste, divisionCode: division }, () => {
                    setPreview(null);
                    setPaste("");
                  })
                }
              >
                Import these rows
              </button>
            </div>
          )}
        </section>
      </div>
      <Table
        caption={`${data.teams.length} teams`}
        heads={["Code / division", "Team & school", "Debaters", "Actions"]}
      >
        {data.teams.map((t) => (
          <tr key={t.id}>
            <th scope="row">
              {t.code}
              <p className="org-muted">{t.divisionCode}</p>
            </th>
            <td>
              {t.name}
              <p className="org-muted">{t.school}</p>
              {t.status !== "active" && <StatusChip variant="warning">Withdrawn</StatusChip>}
            </td>
            <td>
              {t.speakers.map((s) => (
                <div key={s.id}>
                  {s.position}. {s.name}
                </div>
              ))}
            </td>
            <td>
              <details>
                <summary>Edit team</summary>
                <ActionForm
                  command={c}
                  action="team.update"
                  make={(f) => ({
                    teamId: t.id,
                    patch: { ...teamInput(f), expectedRevision: data.draw.revision },
                  })}
                >
                  <TeamFields team={t} />
                </ActionForm>
              </details>
              {t.status === "active" && (
                <details>
                  <summary>Withdraw team</summary>
                  <ActionForm
                    command={c}
                    action="team.withdraw"
                    label="Withdraw team"
                    make={(f) => ({ teamId: t.id, reason: text(f, "reason") })}
                  >
                    <Reason />
                  </ActionForm>
                </details>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
export function JudgesPage({ data }: { data: Data }) {
  const c = useCommand(data.tournament.id);
  const [card, setCard] = useState<{ name: string; code: string; link: string; qr: string } | null>(
    null,
  );
  const cardReady = (value: unknown) => {
    const v = record(value);
    if (typeof v.link === "string")
      void QRCode.toDataURL(v.link, { width: 240, margin: 1 }).then((qr) =>
        setCard({ name: String(v.name), code: String(v.code), link: String(v.link), qr }),
      );
  };
  return (
    <>
      <PageHeader title="Judges" subtitle="Give each judge a clear code and a room for the day." />
      {c.feedback}
      <section className="org-panel max-w-2xl">
        <h2>Add a judge</h2>
        <ActionForm
          command={c}
          action="judge.create"
          primary
          label="Add judge"
          make={(f) => ({
            name: text(f, "name"),
            code: text(f, "code") || undefined,
            homeRoomId: text(f, "homeRoomId") || null,
          })}
        >
          <Field name="name" label="Judge name" required />
          <Field name="code" label="Short code (optional)" />
          <Field name="homeRoomId" label="Home room">
            <option value="">Assign later</option>
            {data.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Field>
        </ActionForm>
      </section>
      {card && (
        <section className="org-panel" aria-label="Issued judge card">
          <h2>{card.name}</h2>
          <p className="org-card-code">{card.code}</p>
          <Image
            unoptimized
            src={card.qr}
            width={240}
            height={240}
            alt={`Join QR code for ${card.name}`}
          />
          <a href={card.link}>Open judge scoresheets</a>
          <p className="org-muted">
            This private card gives access as this judge. Share it only with them.
          </p>
          <button className="org-button" onClick={() => window.print()}>
            Print card
          </button>
          <button className="org-button" onClick={() => setCard(null)}>
            Close card
          </button>
        </section>
      )}
      <Table
        caption={`${data.judges.length} judges`}
        heads={["Code", "Judge / home room", "Phones", "Actions"]}
      >
        {data.judges.map((j) => (
          <tr key={j.id}>
            <th scope="row">{j.code}</th>
            <td>
              {j.name}
              <p className="org-muted">
                {data.rooms.find((r) => r.id === j.homeRoomId)?.name ?? "No home room"} · {j.status}
              </p>
            </td>
            <td>
              {j.devices.length ? (
                j.devices.map((d) => (
                  <div key={d.deviceId}>
                    <p>
                      {d.appVersion ?? "Phone"} · {d.queuedCount} waiting to send
                    </p>
                    <p className="org-muted">
                      Last heard {new Date(d.lastSeenAt).toLocaleString("en-GB")}
                    </p>
                    <span className="org-muted">Device {d.deviceId.slice(0, 8)}</span>
                  </div>
                ))
              ) : (
                <span className="org-muted">No phone has joined</span>
              )}
            </td>
            <td>
              {data.owner && (
                <button
                  className="org-button"
                  onClick={() => c.execute("judge.card", { judgeId: j.id }, cardReady)}
                >
                  Issue QR card
                </button>
              )}
              <details>
                <summary>Edit judge</summary>
                <ActionForm
                  command={c}
                  action="judge.update"
                  make={(f) => ({
                    judgeId: j.id,
                    patch: {
                      name: text(f, "name"),
                      homeRoomId: text(f, "homeRoomId") || null,
                      expectedRevision: data.draw.revision,
                    },
                  })}
                >
                  <Field name="name" label="Name" required value={j.name} />
                  <Field name="homeRoomId" label="Home room" value={j.homeRoomId ?? ""}>
                    <option value="">No home room</option>
                    {data.rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Field>
                </ActionForm>
              </details>
              <details>
                <summary>Replace judge</summary>
                <ActionForm
                  command={c}
                  action="judge.replace"
                  label="Replace judge"
                  make={(f) => ({
                    oldJudgeId: j.id,
                    newName: text(f, "name"),
                    reason: text(f, "reason"),
                    expectedRevision: data.draw.revision,
                  })}
                >
                  <Field name="name" label="Replacement judge name" required />
                  <Reason />
                </ActionForm>
              </details>
              {data.owner && (
                <details>
                  <summary>Sign out all devices</summary>
                  <ActionForm
                    command={c}
                    action="judge.revoke"
                    label="Sign out all devices"
                    make={(f) => ({ judgeId: j.id, reason: text(f, "reason") })}
                  >
                    <p className="org-muted">
                      Signs this judge out on every phone and rotates their private card. Issue a
                      fresh card to let them rejoin.
                    </p>
                    <Reason />
                  </ActionForm>
                </details>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
export function RoomsPage({ data }: { data: Data }) {
  const c = useCommand(data.tournament.id);
  return (
    <>
      <PageHeader
        title="Rooms & panels"
        subtitle={`${data.tournament.settings.judgesPerRoom} judges per room. ${data.rooms.length} rooms can hold ${data.rooms.length * 2} teams in each round.`}
      />
      {c.feedback}
      <div className="org-grid">
        <section className="org-panel">
          <h2>Add a room</h2>
          <ActionForm
            command={c}
            action="room.create"
            primary
            label="Add room"
            make={(f) => ({ name: text(f, "name") })}
          >
            <Field name="name" label="Room name" required />
          </ActionForm>
        </section>
        <section className="org-panel">
          <h2>Make numbered rooms</h2>
          <ActionForm
            command={c}
            action="room.generate"
            label="Generate rooms"
            make={(f) => ({ count: number(f, "count") })}
          >
            <Field name="count" label="Number of rooms" type="number" required min={1} max={200} />
          </ActionForm>
        </section>
      </div>
      <Table
        caption="Fixed panels stay in the same room all day"
        heads={["Room", "Panel", "Manage"]}
      >
        {data.rooms.map((r) => (
          <tr key={r.id}>
            <th scope="row">{r.name}</th>
            <td>
              {r.judgeIds.map((id) => data.judges.find((j) => j.id === id)?.name).join(" · ") ||
                "No judges assigned"}
            </td>
            <td>
              <details>
                <summary>Set panel</summary>
                <ActionForm
                  command={c}
                  action="room.panel"
                  label="Save panel"
                  make={(f) => ({ roomId: r.id, judgeIds: f.getAll("judgeId").map(String) })}
                >
                  {data.judges
                    .filter((j) => j.status === "active")
                    .map((j) => (
                      <label className="org-check" key={j.id}>
                        <input
                          type="checkbox"
                          name="judgeId"
                          value={j.id}
                          defaultChecked={r.judgeIds.includes(j.id)}
                        />
                        {j.code} · {j.name}
                        {j.homeRoomId && j.homeRoomId !== r.id
                          ? ` (${data.rooms.find((x) => x.id === j.homeRoomId)?.name})`
                          : ""}
                      </label>
                    ))}
                </ActionForm>
              </details>
              <details>
                <summary>Rename room</summary>
                <ActionForm
                  command={c}
                  action="room.update"
                  make={(f) => ({
                    roomId: r.id,
                    patch: { name: text(f, "name"), expectedRevision: data.draw.revision },
                  })}
                >
                  <Field name="name" label="Room name" required value={r.name} />
                </ActionForm>
              </details>
              <button
                className="org-button"
                onClick={() => c.execute("room.delete", { roomId: r.id })}
              >
                Delete unused room
              </button>
            </td>
          </tr>
        ))}
      </Table>
      <section className="org-panel">
        <h2>Panel arrangement</h2>
        <ActionForm
          command={c}
          action="settings.update"
          make={(f) => ({
            expectedRevision: data.draw.revision,
            patch: { panelMode: text(f, "panelMode"), judgesPerRoom: number(f, "judgesPerRoom") },
          })}
        >
          <Field name="panelMode" label="Panel mode" value={data.tournament.settings.panelMode}>
            <option value="fixed-room">Fixed room all day</option>
            <option value="per-round">Choose each round in the draw</option>
          </Field>
          <Field
            name="judgesPerRoom"
            label="Judges per room"
            type="number"
            min={1}
            max={5}
            required
            value={data.tournament.settings.judgesPerRoom}
          />
        </ActionForm>
      </section>
    </>
  );
}
