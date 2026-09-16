import { and, eq } from "drizzle-orm";
import { drawRows, itineraryRows } from "@/domain/export";
import { publicPathFor } from "@/domain/public-page";
import { tournaments } from "@/server/db";
import { errors } from "@/server/errors";
import type { Queryable } from "@/server/services/context";
import { getFinalistConfirmation } from "@/server/services/finalists";
import { loadGraph, toSchedule } from "@/server/services/graph";
import { buildResultsView } from "@/server/services/results";

export async function publicTournament(db: Queryable, key: string) {
  const match = /^(.*)--([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(key);
  if (!match) throw errors.notFound("That public tournament");
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.id, match[2]), eq(tournaments.slug, match[1])));
  if (
    !tournament ||
    !tournament.settings.publicPage?.enabled ||
    tournament.status === "archived" ||
    (tournament.demoExpiresAt && tournament.demoExpiresAt <= new Date())
  )
    throw errors.notFound("That public tournament");
  const graph = await loadGraph(db, tournament.id);
  const schedule = toSchedule(graph);
  const results = [];
  for (const division of graph.divisions) {
    if (!division.finalizedAt && !tournament.settings.publicPage.showProvisional) continue;
    const view = buildResultsView(graph, division.code);
    const confirmation = await getFinalistConfirmation(db, view);
    results.push({
      division: division.name,
      published: !!view.published,
      teams: view.teams.map(({ code, name, school, rank, total }) => ({
        code,
        name,
        school,
        rank,
        total,
      })),
      debaters: view.debaters.map(({ name, teamName, school, rank, total }) => ({
        name,
        teamName,
        school,
        rank,
        total,
      })),
      finalists: confirmation
        ? view.teams
            .filter((team) => confirmation.teamIds.includes(team.id))
            .map((team) => team.name)
        : view.finalists.resolved
          ? view.finalists.teams.map((team) => team.name)
          : [],
      tieAtCut: !confirmation && !!view.finalists.tieAtCut,
    });
  }
  return {
    name: tournament.name,
    practice: tournament.kind !== "live",
    path: publicPathFor(tournament),
    eventDate: schedule.settings.eventDate ?? "",
    venue: schedule.settings.venue ?? "",
    // Explicit projection: no assignments, marks, feedback, access codes or session data.
    draw: drawRows(schedule).map(
      ({
        division,
        round,
        room,
        governmentCode,
        government,
        oppositionCode,
        opposition,
        motion,
      }) => ({
        division,
        round,
        room,
        governmentCode,
        government,
        oppositionCode,
        opposition,
        motion,
      }),
    ),
    itineraries: itineraryRows(schedule).map(
      ({
        division,
        code,
        team,
        school,
        round,
        room,
        side,
        sidesDecided,
        opponent,
        opponentCode,
      }) => ({
        division,
        code,
        team,
        school,
        round,
        room,
        side,
        sidesDecided,
        opponent,
        opponentCode,
      }),
    ),
    results,
  };
}
