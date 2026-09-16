import { eq } from "drizzle-orm";
import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/guards";
import { getDb, organisations } from "@/server/db";
import { PageHeader } from "@/ui";
import { AuthForm } from "@/organiser/auth-form";
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/t" as Route);
  const first = !(
    await (
      await getDb()
    )
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.isDemo, false))
      .limit(1)
  ).length;
  return (
    <>
      <PageHeader title="Welcome back" subtitle="Sign in to run your tournament." />
      <AuthForm mode="signin" next={(await searchParams).next} />
      {first && (
        <p className="mt-6">
          <Link href={"/setup" as Route}>Set up the first organisation</Link>
        </p>
      )}
    </>
  );
}
