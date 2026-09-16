/**
 * Runs before every page and route handler (Next.js 16 "proxy" convention,
 * formerly middleware). It does two small things:
 *
 * 1. Gives every request an id (`x-request-id`), taken from Vercel's header
 *    when present, and echoes it on the response so a person can quote it.
 * 2. Sets the security headers and a Content-Security-Policy.
 *
 * It deliberately does no authentication. Every Server Action and route
 * handler checks the session itself, because a matcher change here would
 * otherwise silently remove protection.
 *
 * CSP status (see the hardening milestone, M7): Next.js hydrates pages with
 * inline scripts, so without nonces or hashes `script-src` must allow
 * 'unsafe-inline' in production as well as in development. Development
 * additionally needs 'unsafe-eval' for Turbopack. The plan is a nonce-based
 * policy for organiser routes (generated here, read in the root layout) and a
 * hash-based policy for the static judge app at /j, whose service worker
 * precache cannot carry per-request nonces. Until then this file ships one
 * policy that works everywhere.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getRequestId, REQUEST_ID_HEADER } from "@/server/request-id";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** Two years, the value preload lists ask for. */
const HSTS_MAX_AGE_SECONDS = 63_072_000;

interface HeaderOptions {
  production: boolean;
}

/** The CSP directives as data, so the policy is easy to read and to test. */
function cspDirectives({ production }: HeaderOptions): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    // 'unsafe-inline' is required by Next's hydration scripts until nonces land.
    "script-src": production
      ? ["'self'", "'unsafe-inline'"]
      : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    // Tailwind and shadcn/base-ui set inline style attributes.
    "style-src": ["'self'", "'unsafe-inline'"],
    // QR codes are rendered to data: URLs and canvas blobs.
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    // Turbopack's hot reload uses a websocket to the dev origin.
    "connect-src": production ? ["'self'"] : ["'self'", "ws:", "wss:"],
    // The judge app's service worker and any blob workers.
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
}

function serialiseCsp(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/**
 * The full set of security headers for one response. Exported so a unit test
 * can assert the policy without running Next.
 */
export function securityHeaders(options: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": serialiseCsp(cspDirectives(options)),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    // The camera is needed on the organiser's device to scan hand-off QR codes.
    // Only features browsers still recognise are listed; an unknown one (such
    // as the retired interest-cohort) logs a console error on every page.
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
    // Lets the judge app tell a Dais response from a captive portal's page.
    "X-Dais": "1",
  };
  if (options.production) {
    // HSTS is only meaningful over HTTPS; browsers ignore it on plain HTTP,
    // so a LAN self-host on http:// is unaffected.
    headers["Strict-Transport-Security"] = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;
  }
  return headers;
}

export function proxy(request: NextRequest): NextResponse {
  const requestId = getRequestId(request.headers);

  // Forward the id to the page or handler so its logs and errors share it.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  const response = NextResponse.next({ request: { headers: requestHeaders } });

  for (const [name, value] of Object.entries(securityHeaders({ production: IS_PRODUCTION }))) {
    response.headers.set(name, value);
  }
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // Everything except Next's static output, the image optimiser, the service
  // worker files (served with their own headers from vercel.json) and static
  // assets in /public. Route handlers under /api are included on purpose.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|sw\\.js|swe-worker-.*|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|txt|xml|webmanifest)$).*)",
  ],
};
