"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { actorForUser, requireUser } from "@/server/auth/guards";
import { getDb } from "@/server/db";
import { toErrorResponse } from "@/server/errors";
import {
  createOrganiserTournament,
  executeOrganiserCommand,
  type OrganiserCommandResult,
} from "@/server/organiser-commands";
import { getRequestId } from "@/server/request-id";
import { createContext, run, SYSTEM_ACTOR, type ServiceResult } from "@/server/services";

async function execute<T>(
  operation: (ctx: ReturnType<typeof createContext>) => Promise<T>,
): Promise<ServiceResult<T>> {
  let requestId = "organiser-action";
  try {
    requestId = getRequestId(await headers());
    const ctx = createContext({ db: await getDb(), actor: SYSTEM_ACTOR, requestId });
    const result = await run(ctx, async () => {
      const current = await requireUser();
      return operation({ ...ctx, actor: actorForUser(current.user) });
    });
    if (result.ok) {
      revalidatePath("/t");
      revalidatePath("/t/[slug]", "layout");
    }
    return result;
  } catch (error) {
    return { ok: false, error: toErrorResponse(error, requestId) };
  }
}

/** One validated command entry point for M3 forms. Inputs are plain objects. */
export async function tournamentCommandAction(
  input: unknown,
): Promise<ServiceResult<OrganiserCommandResult>> {
  return execute((ctx) => executeOrganiserCommand(ctx, input));
}

/** A current organisation member may create a tournament inside that organisation. */
export async function createTournamentAction(
  input: unknown,
): Promise<ServiceResult<Awaited<ReturnType<typeof createOrganiserTournament>>>> {
  return execute((ctx) => createOrganiserTournament(ctx, input));
}
