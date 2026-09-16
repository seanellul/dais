import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/server/db";
import { getEnv } from "@/server/env";
import { getPublicExample } from "@/server/demo-entry";
import { httpError } from "@/server/http";
import { createContext, SYSTEM_ACTOR } from "@/server/services/context";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const location = await getPublicExample(
      createContext({ db: await getDb(), actor: SYSTEM_ACTOR }),
    );
    const response = NextResponse.redirect(new URL(location, getEnv().APP_URL), 307);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return httpError(error, request.headers);
  }
}
