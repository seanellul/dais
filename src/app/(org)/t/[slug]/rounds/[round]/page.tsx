import { notFound } from "next/navigation";
import { TournamentPage } from "@/organiser/tournament-page";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; round: string }>;
  searchParams: Promise<{ room?: string }>;
}) {
  const p = await params;
  const round = Number(p.round);
  if (!Number.isSafeInteger(round) || round < 1) notFound();
  return (
    <TournamentPage slug={p.slug} view="rounds" round={round} roomId={(await searchParams).room} />
  );
}
