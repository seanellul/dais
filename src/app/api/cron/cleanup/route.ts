import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/server/db";
import { getEnv } from "@/server/env";
import { errors } from "@/server/errors";
import { httpError, json } from "@/server/http";
import { cleanupExpired } from "@/server/services/cleanup";
import { createContext, SYSTEM_ACTOR } from "@/server/services/context";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: NextRequest) {
  try {
    const secret = getEnv().CRON_SECRET;
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret ?? ""}`);
    if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw errors.unauthenticated();
    return json({ ok: true, data: await cleanupExpired(createContext({ db: await getDb(), actor: SYSTEM_ACTOR })) });
  } catch (error) { return httpError(error, request.headers); }
}
