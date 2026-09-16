import { organiserTournaments } from "@/server/organiser-queries";
import { TournamentList } from "@/organiser/tournaments";
export default async function Page() {
  return <TournamentList data={await organiserTournaments()} />;
}
