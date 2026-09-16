import { organiserTournament } from "@/server/organiser-queries";
import { Dashboard } from "./run-sheet";
import { TeamsPage, JudgesPage, RoomsPage } from "./setup-pages";
import { DrawPage } from "./draw-page";
import { LivePage } from "./live-page";
import { ResultsPage } from "./results-page";
import { SettingsPage } from "./settings-page";
import { ExportsPage, HistoryPage } from "./record-pages";
export async function TournamentPage({
  slug,
  view = "dashboard",
  round = 1,
  roomId,
}: {
  slug: string;
  view?: string;
  round?: number;
  roomId?: string;
}) {
  const data = await organiserTournament(slug);
  switch (view) {
    case "teams":
      return <TeamsPage data={data} />;
    case "judges":
      return <JudgesPage data={data} />;
    case "rooms":
      return <RoomsPage data={data} />;
    case "draw":
      return <DrawPage data={data} />;
    case "rounds":
      return <LivePage data={data} round={round} roomId={roomId} />;
    case "results":
      return <ResultsPage data={data} />;
    case "settings":
      return <SettingsPage data={data} />;
    case "exports":
      return <ExportsPage data={data} />;
    case "history":
      return <HistoryPage data={data} />;
    default:
      return <Dashboard data={data} />;
  }
}
