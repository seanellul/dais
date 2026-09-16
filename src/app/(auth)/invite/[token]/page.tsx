import Link from "next/link";
import { PageHeader } from "@/ui";
import { AuthForm } from "@/organiser/auth-form";
import { getDb } from "@/server/db";
import { isAppError } from "@/server/errors";
import { findLiveInvite } from "@/server/auth/tokens";
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let invite: Awaited<ReturnType<typeof findLiveInvite>> | null = null;
  let message = "Ask your organisation owner for a fresh invitation.";
  try {
    invite = await findLiveInvite(await getDb(), token);
  } catch (error) {
    if (!isAppError(error) || error.code !== "validation") throw error;
    message = error.message;
  }
  return (
    <>
      <PageHeader
        title={invite ? "You’re invited" : "This invitation can’t be used"}
        subtitle={
          invite
            ? `Join as an ${invite.invite.role}. The invitation is for ${invite.invite.email}.`
            : message
        }
      />
      {invite ? (
        <AuthForm mode="invite" token={token} />
      ) : (
        <Link href="/signin" className="org-button">
          Sign in instead
        </Link>
      )}
    </>
  );
}
