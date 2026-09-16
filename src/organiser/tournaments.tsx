"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { createTournamentAction } from "@/server/actions/tournament";
import type { TournamentListData } from "@/server/organiser-queries";
import { EmptyState, PageHeader, StatusChip } from "@/ui";
import { ActionForm, Field, Reason, Table, text, useCommand } from "./controls";
export function NewTournament({ data }: { data: TournamentListData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  return (
    <>
      <PageHeader
        eyebrow="A fresh run sheet"
        title="New tournament"
        subtitle="Start with two divisions, three rounds and the standard judging rubric."
      />
      <section className="org-panel max-w-2xl">
        <form
          className="org-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            start(async () => {
              const result = await createTournamentAction({
                organisationId: text(f, "organisationId"),
                name: text(f, "name"),
                slug: text(f, "slug") || undefined,
                kind: text(f, "kind"),
              });
              if (!result.ok) setError(result.error.message);
              else router.push(`/t/${result.data.slug}` as Route);
            });
          }}
        >
          <Field name="organisationId" label="Organisation" required>
            {data.organisations
              .filter((o) => !o.isDemo)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </Field>
          <Field name="name" label="Tournament name" required />
          <Field
            name="slug"
            label="Short link name"
            help="Optional. Dais makes one from the name."
          />
          <Field name="kind" label="Tournament type" value="live">
            <option value="live">Live tournament</option>
            <option value="sandbox">Sandbox for practice</option>
          </Field>
          {error && (
            <div role="alert" className="org-error">
              {error}
            </div>
          )}
          <button className="org-button primary" disabled={pending}>
            {pending ? "Creating…" : "Create tournament"}
          </button>
        </form>
      </section>
    </>
  );
}
function TournamentRow({ t }: { t: TournamentListData["tournaments"][number] }) {
  const c = useCommand(t.id);
  return (
    <tr>
      <th scope="row">
        <Link href={`/t/${t.slug}` as Route} className="font-display text-lg">
          {t.name}
        </Link>
        {c.feedback}
      </th>
      <td>
        <StatusChip variant={t.kind === "live" ? "info" : "warning"}>{t.kind}</StatusChip>
      </td>
      <td>{t.status}</td>
      <td>
        <details>
          <summary>Duplicate for next year</summary>
          <ActionForm
            command={c}
            action="tournament.duplicate"
            label="Duplicate"
            make={(f) => ({
              name: text(f, "name"),
              kind: text(f, "kind"),
              copyTeams: f.has("copyTeams"),
            })}
          >
            <Field
              name="name"
              label="New tournament name"
              required
              value={`${t.name} — next year`}
            />
            <Field name="kind" label="Type" value="live">
              <option value="live">Live</option>
              <option value="sandbox">Sandbox</option>
            </Field>
            <label className="org-check">
              <input type="checkbox" name="copyTeams" defaultChecked />
              Copy teams
            </label>
          </ActionForm>
        </details>
        <details>
          <summary>Archive tournament</summary>
          <ActionForm command={c} action="tournament.archive" label="Archive" make={() => ({})}>
            <p className="org-muted">Archive this tournament once you have saved its exports.</p>
          </ActionForm>
        </details>
        <details>
          <summary>Restore a backup</summary>
          <ActionForm
            command={c}
            action="backup.restore"
            label="Restore this tournament"
            make={(f) => ({
              backupText: text(f, "backupText"),
              confirmSlug: text(f, "confirmSlug"),
              reason: text(f, "reason"),
            })}
          >
            <Field name="backupText" label="Backup file contents" type="textarea" required />
            <Field
              name="confirmSlug"
              label={`Type ${t.slug} to replace tournament data`}
              required
            />
            <Reason />
          </ActionForm>
        </details>
      </td>
    </tr>
  );
}
export function TournamentList({ data }: { data: TournamentListData }) {
  const [filter, setFilter] = useState("all");
  const rows = data.tournaments.filter((t) =>
    filter === "all" || filter === "archived"
      ? filter === "all" || t.status === "archived"
      : t.kind === filter && t.status !== "archived",
  );
  return (
    <>
      <PageHeader
        eyebrow="Organiser workspace"
        title="Your tournaments"
        subtitle="The day’s draw, every sheet and a clear record of each decision."
        actions={
          <Link href={"/t/new" as Route} className="org-button primary">
            New tournament
          </Link>
        }
      />
      <div className="org-actions" role="group" aria-label="Filter tournaments">
        {["all", "live", "sandbox", "archived"].map((f) => (
          <button
            key={f}
            className="org-button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      {rows.length ? (
        <Table
          caption={`${rows.length} tournaments`}
          heads={["Tournament", "Type", "Status", "Actions"]}
        >
          {rows.map((t) => (
            <TournamentRow key={t.id} t={t} />
          ))}
        </Table>
      ) : (
        <EmptyState
          title="A clear run sheet"
          description="Create a tournament to add teams, judges and a draw."
          action={
            <Link href={"/t/new" as Route} className="org-button primary">
              New tournament
            </Link>
          }
        />
      )}
    </>
  );
}
