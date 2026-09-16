import { organiserTournaments } from "@/server/organiser-queries";
import { NewTournament } from "@/organiser/tournaments";
export default async function Page() {
  return <NewTournament data={await organiserTournaments()} />;
}
