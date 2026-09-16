"use server";

/**
 * Server Actions for signing up, signing in and out, and invites.
 *
 * Each action parses its input, builds a `ServiceContext` with the request
 * id from the headers, runs the service through `run` (so nothing is ever
 * thrown to the form), writes or clears the cookie, and then redirects.
 * `redirect()` throws on purpose, so it is called only after `run` has
 * returned a success, never inside it.
 *
 * Forms can call these directly (`<form action={signInAction}>`) or through
 * `useActionState((_, form) => signInAction(form), null)` to show the
 * returned error next to the fields.
 */
import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  acceptInviteSchema,
  createInviteSchema,
  parseInput,
  signInSchema,
  signUpSchema,
  type ActionInput,
} from "@/server/auth/forms";
import { actorForUser, requireUser } from "@/server/auth/guards";
import { clientIpOf, ipHashOf, userAgentOf } from "@/server/auth/request-meta";
import {
  ORGANISER_COOKIE,
  clearSessionCookie,
  createUserSession,
  resolveUserSession,
  revokeSession,
  setSessionCookie,
} from "@/server/auth/session";
import { acceptInviteWithSession } from "@/server/auth/invite-acceptance";
import { createInvite, inviteLinkFor } from "@/server/auth/tokens";
import { getDb } from "@/server/db";
import { errors, toErrorResponse } from "@/server/errors";
import { getRequestId } from "@/server/request-id";
import {
  SYSTEM_ACTOR,
  createContext,
  run,
  withTransaction,
  type Actor,
  type ServiceContext,
  type ServiceResult,
} from "@/server/services";
import { signIn, signUpFirstOwner } from "@/server/services/users";

/**
 * Where a signed-in organiser lands. Typed routes only know pages that
 * exist at build time and the organiser pages arrive with M3, so the
 * paths are cast to `Route` here rather than checked.
 */
const HOME_AFTER_SIGN_IN = "/t" as Route;
/** Where a signed-out organiser lands. */
const HOME_AFTER_SIGN_OUT = "/" as Route;

/** The actor for a request that has no session yet. */
const ANONYMOUS_ACTOR: Actor = { ...SYSTEM_ACTOR, id: "anonymous", name: "Sign-in form" };

/** A context for this request, with the id the proxy assigned. */
async function contextFor(actor: Actor): Promise<ServiceContext> {
  const requestHeaders = await headers();
  return createContext({
    db: await getDb(),
    actor,
    requestId: getRequestId(requestHeaders),
  });
}

/** The device facts a new session records. */
async function deviceMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const requestHeaders = await headers();
  return { ip: clientIpOf(requestHeaders), userAgent: userAgentOf(requestHeaders) };
}

/** A failed parse as the action result, under this request's id. */
async function invalid<T>(error: unknown): Promise<ServiceResult<T>> {
  const requestId = getRequestId(await headers());
  return { ok: false, error: toErrorResponse(error, requestId) };
}

/**
 * First-run sign-up: creates the organisation and its owner, signs them
 * in and goes to the tournaments list. Refused once an organisation exists.
 */
export async function signUpAction(input: ActionInput): Promise<ServiceResult<{ userId: string }>> {
  const parsed = parseInput(signUpSchema, input);
  if (!parsed.ok) return invalid(parsed.error);

  const ctx = await contextFor(ANONYMOUS_ACTOR);
  const meta = await deviceMeta();
  const result = await run(ctx, () =>
    withTransaction(ctx, async (tx) => {
      const signedUp = await signUpFirstOwner(tx, ctx, parsed.value);
      const asOwner = { ...ctx, actor: actorForUser(signedUp.user) };
      const session = await createUserSession(tx, asOwner, signedUp.user.id, {
        userAgent: meta.userAgent,
        ipHash: ipHashOf(meta.ip),
      });
      return { userId: signedUp.user.id, token: session.token };
    }),
  );
  if (!result.ok) return result;

  await setSessionCookie(cookies(), result.data.token);
  redirect(HOME_AFTER_SIGN_IN);
}

/** Signs an organiser in and goes to `next` (a path on this site) or the tournaments list. */
export async function signInAction(input: ActionInput): Promise<ServiceResult<{ userId: string }>> {
  const parsed = parseInput(signInSchema, input);
  if (!parsed.ok) return invalid(parsed.error);

  const ctx = await contextFor(ANONYMOUS_ACTOR);
  const meta = await deviceMeta();
  const result = await run(ctx, () =>
    signIn(ctx, { email: parsed.value.email, password: parsed.value.password, ...meta }),
  );
  if (!result.ok) return result;

  await setSessionCookie(cookies(), result.data.token);
  redirect((parsed.value.next as Route | undefined) ?? HOME_AFTER_SIGN_IN);
}

/**
 * Signs the current organiser out of this device. The cookie is cleared
 * even when there was no live session behind it.
 */
export async function signOutAction(): Promise<ServiceResult<{ signedOut: boolean }>> {
  const store = await cookies();
  const token = store.get(ORGANISER_COOKIE)?.value;
  const ctx = await contextFor(ANONYMOUS_ACTOR);
  const result = await run(ctx, async () => {
    if (!token) return { signedOut: false };
    const current = await resolveUserSession(ctx.db, token, ctx.now);
    if (!current) return { signedOut: false };
    const asUser = { ...ctx, actor: actorForUser(current.user) };
    const signedOut = await withTransaction(asUser, (tx) =>
      revokeSession(tx, asUser, current.session.id, "signed out"),
    );
    return { signedOut };
  });
  await clearSessionCookie(store);
  if (!result.ok) return result;
  redirect(HOME_AFTER_SIGN_OUT);
}

/**
 * Creates an invite link for an organisation the current user owns. The
 * link is returned once; Dais sends no email, so the owner passes it on.
 */
export async function createInviteAction(
  input: ActionInput,
): Promise<ServiceResult<{ inviteId: string; link: string; expiresAt: string }>> {
  const parsed = parseInput(createInviteSchema, input);
  if (!parsed.ok) return invalid(parsed.error);

  const ctx = await contextFor(ANONYMOUS_ACTOR);
  return run(ctx, async () => {
    const current = await requireUser();
    const asUser = { ...ctx, actor: actorForUser(current.user) };
    const ownerOf = current.memberships.some(
      (m) => m.organisationId === parsed.value.organisationId && m.role === "owner",
    );
    if (!ownerOf) throw errors.forbidden("Only an owner of the organisation can invite people.");
    const invite = await withTransaction(asUser, (tx) =>
      createInvite(tx, asUser, {
        organisationId: parsed.value.organisationId,
        email: parsed.value.email,
        role: parsed.value.role,
        invitedBy: current.user.id,
      }),
    );
    return {
      inviteId: invite.inviteId,
      link: inviteLinkFor(invite.token),
      expiresAt: invite.expiresAt.toISOString(),
    };
  });
}

/** Accepts an invite, creates the account and membership, signs in and goes to the tournaments list. */
export async function acceptInviteAction(
  input: ActionInput,
): Promise<ServiceResult<{ userId: string; organisationId: string }>> {
  const parsed = parseInput(acceptInviteSchema, input);
  if (!parsed.ok) return invalid(parsed.error);

  const ctx = await contextFor(ANONYMOUS_ACTOR);
  const meta = await deviceMeta();
  const result = await run(ctx, () =>
    acceptInviteWithSession(
      ctx,
      parsed.value.token,
      {
        name: parsed.value.name,
        password: parsed.value.password,
      },
      meta,
    ),
  );
  if (!result.ok) return result;

  await setSessionCookie(cookies(), result.data.token);
  redirect(HOME_AFTER_SIGN_IN);
}
