/** Request-level invite acceptance: invite claim, membership and session stay atomic. */
import { eq } from "drizzle-orm";
import { rateLimits } from "@/server/db";
import { withTransaction, type ServiceContext } from "@/server/services/context";
import { acceptInvite, findLiveInvite, normaliseEmail, type AcceptInviteInput } from "./tokens";
import { createUserSession } from "./session";
import { ipHashOf } from "./request-meta";
import { RATE_LIMITS, assertAllowed, rateLimitKey, takeAll, windowKey } from "./rate-limit";

export interface InviteAcceptanceMeta {
  /** Read from trusted request headers by the Server Action, never from its form. */
  ip: string | null;
  userAgent: string | null;
}

export async function acceptInviteWithSession(
  ctx: ServiceContext,
  token: string,
  input: AcceptInviteInput,
  meta: InviteAcceptanceMeta,
) {
  // The email comes from the stored invite, not the request or token id.
  // Fresh links and ordinary sign-in therefore share one password budget.
  const { invite } = await findLiveInvite(ctx.db, token, ctx.now);
  const emailKey = rateLimitKey("organiser-signin", "email", normaliseEmail(invite.email));
  const ipKey = rateLimitKey("organiser-signin", "ip", ipHashOf(meta.ip));
  const attemptedAt = ctx.now();
  const decisions = await withTransaction(ctx, (tx) =>
    takeAll(
      tx,
      [
        { key: ipKey, policy: RATE_LIMITS.organiserSignInPerIp },
        { key: emailKey, policy: RATE_LIMITS.organiserSignInPerEmail },
      ],
      () => attemptedAt,
    ),
  );
  // Judge only after commit: wrong passwords and failed invite claims cannot
  // erase their attempt counts when the acceptance transaction rolls back.
  assertAllowed(decisions);

  return withTransaction(ctx, async (tx) => {
    const accepted = await acceptInvite(tx, ctx, token, input);
    const asUser = {
      ...ctx,
      actor: { type: "user" as const, id: accepted.user.id, name: accepted.user.name },
    };
    const session = await createUserSession(tx, asUser, accepted.user.id, {
      userAgent: meta.userAgent,
      ipHash: ipHashOf(meta.ip),
    });
    await tx
      .delete(rateLimits)
      .where(
        eq(rateLimits.key, windowKey(emailKey, RATE_LIMITS.organiserSignInPerEmail, attemptedAt)),
      );
    return {
      userId: accepted.user.id,
      organisationId: accepted.organisation.id,
      token: session.token,
    };
  });
}
