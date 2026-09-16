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
 * Production dynamic pages receive a per-request nonce. Immutable pages use
 * exact inline-script hashes installed by scripts/static-csp.mjs after build,
 * so the judge shell can be safely precached and reopened offline.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getRequestId, REQUEST_ID_HEADER } from "@/server/request-id";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** Two years, the value preload lists ask for. */
const HSTS_MAX_AGE_SECONDS = 63_072_000;

interface HeaderOptions {
  production: boolean;
  nonce?: string;
}

/** The CSP directives as data, so the policy is easy to read and to test. */
function cspDirectives({ production, nonce }: HeaderOptions): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": production
      ? ["'self'", ...(nonce ? [`'nonce-${nonce}'`] : [])]
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

/** Replaced in compiled proxy output after immutable HTML has been generated. */
function staticCspFor(pathname: string): string | undefined {
  try {
    return (JSON.parse("__DAIS_STATIC_CSP__") as Record<string, string>)[pathname];
  } catch {
    return undefined; // Development does not run the production post-build step.
  }
}

/**
 * The full set of security headers for one response. Exported so a unit test
 * can assert the policy without running Next.
 */
export function securityHeaders(options: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": serialiseCsp(cspDirectives(options)),
    "X-Content-Type-Options": "nosniff",
    // Preserve the origin on native POST forms, while never disclosing join
    // token paths/queries to another request (even on the same origin).
    "Referrer-Policy": "strict-origin",
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
  const pathname = new URL(request.url).pathname.replace(/\/$/, "") || "/";
  // Immutable build output: post-build injects its exact inline-script hashes
  // into this proxy, so all deployment adapters preserve the response header.
  const staticPage = ["/", "/j", "/j/join", "/design", "/demo/judge"].includes(pathname);
  const nonce =
    IS_PRODUCTION && !staticPage ? Buffer.from(crypto.randomUUID()).toString("base64") : undefined;
  const responseHeaders = securityHeaders({ production: IS_PRODUCTION, nonce });
  if (IS_PRODUCTION && staticPage) {
    responseHeaders["Content-Security-Policy"] =
      staticCspFor(pathname) ?? "default-src 'none'; frame-ancestors 'none'";
  }
  if (nonce) {
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", responseHeaders["Content-Security-Policy"]);
  }
  // Next's redirect matcher makes a trailing slash optional, so a config
  // redirect for /j would also redirect /j/ to itself. Match the raw path.
  const response =
    new URL(request.url).pathname === "/j"
      ? NextResponse.redirect(
          new URL("/j/" + new URL(request.url).search, process.env.APP_URL || request.url),
          308,
        )
      : NextResponse.next({ request: { headers: requestHeaders } });

  for (const [name, value] of Object.entries(responseHeaders)) {
    response.headers.set(name, value);
  }
  response.headers.set(REQUEST_ID_HEADER, requestId);
  if (nonce) response.headers.set("Cache-Control", "private, no-store");
  // Keep browser retention in step with the database's sliding expiry.
  // The protected page/action still validates expiry and revocation; echoing
  // an expired token here never grants access or extends its database row.
  const organiserToken = request.cookies.get("dais.org")?.value;
  if (
    /^\/t(?:\/|$)/.test(request.nextUrl.pathname) &&
    organiserToken &&
    /^[\w-]{43}$/.test(organiserToken)
  ) {
    response.cookies.set("dais.org", organiserToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    response.headers.set("Cache-Control", "private, no-store");
  }
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
