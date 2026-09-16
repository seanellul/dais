import { TournamentPage } from "@/organiser/tournament-page";
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <TournamentPage slug={(await params).slug} view="draw" />;
}
