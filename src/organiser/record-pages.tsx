"use client";
import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { PageHeader } from "@/ui";
import { date, human, record, type Data } from "./controls";
const prints = [
  ["doors", "Door sheets", "The day’s debates on each room door."],
  ["itineraries", "Team itineraries", "A clear route through all rounds."],
  ["judges", "Judge cards", "Private A6 cards for the judging panels."],
  ["scoresheets", "Blank scoresheets", "Prefilled names and motions for paper scoring."],
  ["feedback", "Feedback sheets", "Debater feedback grouped by school."],
  ["results", "Results", "Rankings and finalists with publication status."],
];
const downloads = [
  ["workbook", "Director’s workbook", "XLSX with formulas and cached scores"],
  ["draw", "Draw", "CSV"],
  ["itineraries", "Itineraries", "CSV"],
  ["debaters", "Debaters", "CSV"],
  ["teams", "Teams", "CSV"],
  ["scores", "Scores", "CSV"],
  ["feedback", "Feedback", "CSV"],
  ["backup", "Tournament backup", "JSON for restoring the complete tournament"],
];
export function ExportsPage({ data }: { data: Data }) {
  const [division, setDivision] = useState("");
  const query = division ? `?division=${encodeURIComponent(division)}` : "";
  return (
    <>
      <PageHeader
        title="Exports & print"
        subtitle="Clear paper copies for the room, the team and the tournament record."
      />
      <label className="org-field max-w-xs">
        Division
        <select value={division} onChange={(e) => setDivision(e.target.value)}>
          <option value="">All divisions</option>
          {data.tournament.settings.divisions.map((d) => (
            <option key={d.code} value={d.code}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <h2>Print-ready sheets</h2>
      <div className="org-grid">
        {prints.map(([kind, title, description]) => (
          <section key={kind} className="org-panel">
            <h3 className="font-display text-xl">{title}</h3>
            <p className="org-muted">{description}</p>
            <div className="org-actions mt-4">
              <Link
                href={`/t/${data.tournament.slug}/print/${kind}${query}` as Route}
                className="org-button"
              >
                Print preview
              </Link>
              <a
                href={`/api/t/${data.tournament.id}/export/pdf-${kind}${query}`}
                className="org-button"
              >
                Download PDF
              </a>
            </div>
          </section>
        ))}
      </div>
      <h2>Downloads</h2>
      <div className="org-panel">
        {downloads.map(([kind, title, description]) => (
          <div
            key={kind}
            className="flex flex-wrap justify-between items-center gap-3 py-4 border-b border-border"
          >
            <div>
              <h3>{title}</h3>
              <p className="org-muted">{description}</p>
            </div>
            <a className="org-button" href={`/api/t/${data.tournament.id}/export/${kind}${query}`}>
              Download {kind === "workbook" ? "XLSX" : kind === "backup" ? "backup" : "CSV"}
            </a>
          </div>
        ))}
      </div>
    </>
  );
}
export function HistoryPage({ data }: { data: Data }) {
  const [filter, setFilter] = useState("");
  const activities = data.activity.filter(
    (a) =>
      !filter ||
      `${a.action} ${a.actorName} ${a.reason ?? ""}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        title="Tournament history"
        subtitle="Who changed what, when they changed it and the reason they gave."
      />
      <label className="org-field max-w-lg">
        Search activity
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Judge, draw, paper, reason…"
        />
      </label>
      <ol className="org-timeline">
        {activities.map((a) => (
          <li key={a.id}>
            <p>
              <strong>{a.actorName ?? "Tournament"}</strong> ·{" "}
              {a.action.replaceAll(".", " ").replaceAll("_", " ")}
            </p>
            <p className="org-muted">{date(a.at)}</p>
            {a.reason && <p className="mt-2">{a.reason}</p>}
            {Array.isArray(a.diff) && a.diff.length > 0 && (
              <details>
                <summary>See changes</summary>
                <ul>
                  {a.diff.map((value, i) => {
                    const d = record(value);
                    return (
                      <li key={i}>
                        <strong>
                          {Array.isArray(d.path) ? d.path.map(String).join(" › ") : "Change"}
                        </strong>
                        :{" "}
                        {d.type === "CREATE"
                          ? "Added"
                          : d.type === "REMOVE"
                            ? "Removed"
                            : "Changed"}{" "}
                        {human(d.oldValue)} → {human(d.value)}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ol>
      {activities.length === 0 && <p className="org-muted">No matching activity.</p>}
    </>
  );
}
