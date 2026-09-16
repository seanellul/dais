/**
 * What a sign-in records about the request: a hash of the client address
 * for rate limits and session listings, and the user agent so an organiser
 * can recognise "Safari on iPhone" in the list of signed-in devices.
 *
 * Addresses are never stored raw. `ipHashOf` peppers them with the session
 * secret, so a copy of the database cannot be turned back into addresses.
 */
import { hashToken } from "@/server/services";
import type { HeaderReader } from "@/server/request-id";

/** The bucket used when no address can be read (tests, some proxies). */
const UNKNOWN_ADDRESS = "unknown";

const MAX_USER_AGENT_LENGTH = 300;

/**
 * The client address, read only from headers a trusted proxy sets. Null
 * (one shared "unknown" bucket) when no proxy is trusted, because a client
 * can send any `x-forwarded-for` it likes and would otherwise dodge the
 * per-address limits with a fresh value on every request.
 *
 * - On Vercel (`VERCEL=1`) the platform overwrites `x-vercel-forwarded-for`.
 * - Self-hosted, set `TRUST_PROXY=1` only when a reverse proxy (nginx,
 *   Caddy, a load balancer) sits in front of Dais and sets `x-real-ip` or
 *   appends to `x-forwarded-for`. The last forwarded entry is the one that
 *   proxy added, so it is the one used; earlier entries are client supplied.
 * - With neither, the whole venue shares one bucket, which the judge limits
 *   are sized for.
 */
export function clientIpOf(headers: HeaderReader): string | null {
  const vercel = headers.get("x-vercel-forwarded-for")?.trim();
  if (process.env.VERCEL === "1" && vercel) return vercel;
  const real = headers.get("x-real-ip")?.trim();
  if (process.env.TRUST_PROXY === "1" && real) return real;
  if (process.env.TRUST_PROXY !== "1") return null;
  const forwarded = headers.get("x-forwarded-for");
  const entries = forwarded?.split(",").map((value) => value.trim()).filter(Boolean);
  if (entries?.length) return entries.at(-1) ?? null;
  return null;
}

/** The user agent, trimmed to a sensible length for the sessions table. */
export function userAgentOf(headers: HeaderReader): string | null {
  const agent = headers.get("user-agent")?.trim();
  if (!agent) return null;
  return agent.length > MAX_USER_AGENT_LENGTH ? agent.slice(0, MAX_USER_AGENT_LENGTH) : agent;
}

/** A stable, peppered hash of an address; missing addresses share one bucket. */
export function ipHashOf(ip: string | null | undefined): string {
  return hashToken(`ip:${ip?.trim() || UNKNOWN_ADDRESS}`);
}
