import { notFound } from "next/navigation";
import Link from "next/link";
import { PrintButton } from "@/components/print-button";
import { getDb } from "@/server/db";
import { isAppError } from "@/server/errors";
import { publicTournament } from "@/server/public-tournament";

export const dynamic = "force-dynamic";
const score = (value: number | null) =>
  value === null ? "—" : Number(value.toFixed(2)).toString();

export default async function PublicTournament({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; view?: string }>;
}) {
  const { slug } = await params;
  const { q = "", view = "rooms" } = await searchParams;
  const data = await publicTournament(await getDb(), slug).catch((error: unknown) => {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  });
  const query = q.toLocaleLowerCase("en-GB");
  const matches = (row: object) =>
    Object.values(row).join(" ").toLocaleLowerCase("en-GB").includes(query);
  const draw = data.draw.filter(matches),
    itineraries = data.itineraries.filter(matches);
  return (
    <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-10">
      <header className="mb-10 border-b pb-8">
        <p className="mb-3 text-sm uppercase tracking-widest">Dais · Tournament day</p>
        {data.practice && (
          <p className="mb-3 rounded border border-warning p-3 text-sm">
            DEMO / PRACTICE · All names and results in the example are fictional.
          </p>
        )}
        <h1 className="mb-4 font-serif text-4xl sm:text-5xl">{data.name}</h1>
        <p className="text-muted-foreground">
          {[data.eventDate, data.venue].filter(Boolean).join(" · ")}
        </p>
      </header>
      <div data-print="hide" className="mb-6 flex flex-wrap gap-4">
        <PrintButton />
        <Link href="/" className="rounded-lg border px-5 py-3">
          About Dais
        </Link>
      </div>
      <section aria-labelledby="schedule-heading">
        <h2 id="schedule-heading" className="mb-4 text-2xl font-semibold">
          Schedule
        </h2>
        <p className="mb-5 text-muted-foreground">
          Judges stay in their rooms. Teams follow their itinerary for each round.
        </p>
        <form data-print="hide" method="get" className="mb-6 flex flex-wrap items-end gap-3">
          <label className="grid gap-2">
            Find a team, school or room
            <input
              name="q"
              defaultValue={q}
              className="min-h-12 rounded-md border bg-background px-3"
            />
          </label>
          <label className="grid gap-2">
            Schedule view
            <select
              name="view"
              defaultValue={view}
              className="min-h-12 rounded-md border bg-background px-3"
            >
              <option value="rooms">By room</option>
              <option value="teams">By team</option>
            </select>
          </label>
          <button className="min-h-12 rounded-md bg-primary px-5 text-primary-foreground">
            Show schedule
          </button>
        </form>
        {view === "teams" ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {itineraries.map((row, index) => (
              <article key={index} className="rounded-xl border bg-card p-5">
                <p className="mb-2 text-sm text-muted-foreground">
                  {row.division} · {row.school}
                </p>
                <h3 className="text-lg font-semibold">
                  {row.code} · {row.team}
                </h3>
                <p className="my-3 text-xl">
                  Round {row.round} · {row.room}
                </p>
                <p>
                  Against {row.opponentCode} · {row.opponent}
                </p>
                <p className="mt-3 font-medium">
                  {row.sidesDecided === "in-room" ? "Sides: coin toss in the room" : row.side}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {draw.map((row, index) => (
              <article key={index} className="rounded-xl border bg-card p-5">
                <p className="mb-2 text-sm text-muted-foreground">
                  {row.division} · Round {row.round}
                </p>
                <h3 className="mb-4 text-xl font-semibold">{row.room}</h3>
                <p>
                  <strong>{row.governmentCode}</strong> · {row.government}
                </p>
                <p className="my-1 text-sm text-muted-foreground">versus</p>
                <p>
                  <strong>{row.oppositionCode}</strong> · {row.opposition}
                </p>
                <p className="mt-4 text-sm">{row.motion || "Motion to be announced"}</p>
              </article>
            ))}
          </div>
        )}
        {!(view === "teams" ? itineraries : draw).length && (
          <p className="rounded-lg border p-6">No matching debates. Try another search.</p>
        )}
      </section>
      <section aria-labelledby="results-heading" className="mt-14">
        <h2 id="results-heading" className="mb-4 text-2xl font-semibold">
          Results
        </h2>
        {!data.results.length && (
          <p className="rounded-lg border p-6">
            Results will appear here when the organiser publishes them.
          </p>
        )}
        {data.results.map((division) => (
          <div key={division.division} className="mb-10">
            <h3 className="mb-3 text-xl font-semibold">
              {division.division} · {division.published ? "Published" : "Provisional"}
            </h3>
            {!division.published && (
              <p className="mb-4">
                These scores may change while sheets and decisions are still arriving.
              </p>
            )}
            {division.finalists.length === 2 && (
              <p className="mb-4 rounded-lg border p-4">
                <strong>{division.published ? "Finalists" : "Currently leading"}:</strong>{" "}
                {division.finalists.join(" and ")}
              </p>
            )}
            {division.tieAtCut && (
              <p className="mb-4">
                There is a tie at the final place. The organiser will confirm the finalists.
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left">
                <caption className="sr-only">{division.division} team results</caption>
                <thead>
                  <tr>
                    {["Rank", "Team", "School", "Total"].map((title) => (
                      <th key={title} className="border-b p-3">
                        {title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...division.teams]
                    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
                    .map((team) => (
                      <tr key={team.code}>
                        <td className="border-b p-3">{score(team.rank)}</td>
                        <td className="border-b p-3">
                          {team.code} · {team.name}
                        </td>
                        <td className="border-b p-3">{team.school}</td>
                        <td className="border-b p-3 font-mono">{score(team.total)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <details className="mt-4 rounded-lg border p-4">
              <summary className="cursor-pointer py-2 font-semibold">Debater results</summary>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-left">
                  <thead>
                    <tr>
                      {["Rank", "Debater", "Team", "Total"].map((title) => (
                        <th key={title} className="border-b p-3">
                          {title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...division.debaters]
                      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
                      .map((debater, index) => (
                        <tr key={index}>
                          <td className="border-b p-3">{score(debater.rank)}</td>
                          <td className="border-b p-3">{debater.name}</td>
                          <td className="border-b p-3">{debater.teamName}</td>
                          <td className="border-b p-3">{score(debater.total)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        ))}
      </section>
    </main>
  );
}
