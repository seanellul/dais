import { NextRequest, NextResponse } from "next/server";
import { clientIpOf, ipHashOf } from "@/server/auth/request-meta";
import { enforce, RATE_LIMITS, rateLimitKey } from "@/server/auth/rate-limit";
import { ORGANISER_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { getDb } from "@/server/db";
import { getEnv } from "@/server/env";
import { startVisitorDemo } from "@/server/demo-entry";
import { assertSameOrigin, httpError } from "@/server/http";
import { createContext, SYSTEM_ACTOR } from "@/server/services/context";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request.headers);
    const db = await getDb();
    await enforce(
      db,
      rateLimitKey("demo-create", ipHashOf(clientIpOf(request.headers))),
      RATE_LIMITS.demoCreatePerIp,
    );
    const result = await startVisitorDemo(
      createContext({ db, actor: SYSTEM_ACTOR }),
      request.cookies.get(ORGANISER_COOKIE)?.value,
      request.nextUrl.searchParams.get("mode") === "judge",
    );
    const response = NextResponse.redirect(new URL(result.location, getEnv().APP_URL), 303);
    response.headers.set("Cache-Control", "private, no-store");
    if (result.token)
      response.cookies.set(ORGANISER_COOKIE, result.token, {
        ...sessionCookieOptions(),
        maxAge: 24 * 60 * 60,
      });
    return response;
  } catch (error) {
    return httpError(error, request.headers);
  }
}
