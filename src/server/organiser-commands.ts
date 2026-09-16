import { attachOrphan, discardOrphan } from "@/server/services/unmatched";
/** Validated organiser mutations shared by Server Actions and integration tests. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { settingsSchema } from "@/domain/settings";
import {
  judges,
  organisations,
  memberships,
  type JudgeRow,
  type TournamentRow,
  type Tx,
} from "@/server/db";
import { errors } from "@/server/errors";
import { issueJoinToken, joinLinkFor } from "@/server/auth/tokens";
import { revokeJudgeSessions } from "@/server/auth/judge-session";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { withTransaction, type Queryable, type ServiceContext } from "@/server/services/context";
import * as teamService from "@/server/services/teams";
import * as judgeService from "@/server/services/judges";
import * as roomService from "@/server/services/rooms";
import * as drawService from "@/server/services/draw";
import * as roundService from "@/server/services/rounds";
import * as tournamentService from "@/server/services/tournaments";
import * as sheetService from "@/server/services/sheets";
import * as overrideService from "@/server/services/overrides";
import * as waiverService from "@/server/services/waivers";
import * as finalizeService from "@/server/services/finalize";
import * as simulateService from "@/server/services/simulate";
import { resolveConflict } from "@/server/services/conflicts";
import { setChecklistOverride } from "@/server/services/checklist";
import {
  updateSettings,
  updateScoringPolicy,
  loppingPolicySchema,
} from "@/server/services/settings";
import { restoreInPlace } from "@/server/services/backup";
import { resetSandbox } from "@/server/services/sandbox";
import { confirmFinalists } from "@/server/services/finalists";

const id = z.uuid();
const sheetId = z.string().regex(/^asg_[A-Za-z0-9_-]{1,60}$/);
const text = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(1).max(2000);
const divisionCode = z.string().trim().min(1).max(32);
const revision = z.number().int().min(0).max(2_147_483_647);
const round = z.number().int().min(1).max(100);
const motion = z.string().trim().max(4000);
const speaker = z.strictObject({ position: z.union([z.literal(1), z.literal(2)]), name: text });
const speakers = z.array(speaker).min(1).max(2);
const orphanOptions = { allowOrphans: z.boolean().optional(), reason: reason.optional() };
const drawPatch = z.strictObject({
  roomId: id.optional(),
  governmentTeamId: id.optional(),
  oppositionTeamId: id.optional(),
  judgeIds: z.array(id).min(1).max(5).optional(),
  motion: motion.optional(),
});
const debate = z.strictObject({
  // Preview ids are readable placeholders; saveDraw reconciles them within this tournament.
  id: z.string().trim().min(1).max(128).optional(),
  divisionCode,
  round,
  roomId: id,
  governmentTeamId: id,
  oppositionTeamId: id,
  judgeIds: z.array(id).min(1).max(5),
  motion: motion.optional(),
});
const importData = z.strictObject({
  text: z.string().min(1).max(1_000_000),
  divisionCode: divisionCode.optional(),
});
const score = z.strictObject({
  argumentation: z.number().min(0).max(1000),
  rebuttal: z.number().min(0).max(1000),
  presentation: z.number().min(0).max(1000),
  poi: z.number().min(0).max(1000),
  overall: z.number().min(0).max(1000),
  www: z.string().max(20_000),
  ebi: z.string().max(20_000),
});
const payload = z.strictObject({
  scores: z
    .record(id, score)
    .refine((value) => Object.keys(value).length === 4, "A sheet scores four debaters."),
  sideFlipped: z.boolean(),
  roleSwaps: z.record(id, z.boolean()),
});
const simulation = {
  seed: z.string().max(200).optional(),
  rogueChance: z.number().min(0).max(1).optional(),
};
function command<const A extends string, S extends z.ZodType>(action: A, data: S) {
  return z.strictObject({ tournamentId: id, action: z.literal(action), data });
}

/** Input is a discriminated union. No numeric coercion or browser-supplied parsed import. */
export const organiserCommandSchema = z.discriminatedUnion("action", [
  command(
    "team.create",
    z.strictObject({
      divisionCode,
      name: text,
      school: text,
      code: text.optional(),
      seed: z.number().int().min(0).max(10000).nullish(),
      speakers,
    }),
  ),
  command(
    "team.update",
    z.strictObject({
      teamId: id,
      patch: z.strictObject({
        name: text.optional(),
        school: text.optional(),
        code: text.optional(),
        seed: z.number().int().min(0).max(10000).nullish(),
        speakers: speakers.optional(),
        expectedRevision: revision.optional(),
      }),
    }),
  ),
  command("team.withdraw", z.strictObject({ teamId: id, reason })),
  command("team.import.preview", importData),
  command("team.import.commit", importData),
  command(
    "judge.create",
    z.strictObject({ name: text, code: text.optional(), homeRoomId: id.nullish() }),
  ),
  command(
    "judge.update",
    z.strictObject({
      judgeId: id,
      patch: z.strictObject({
        name: text.optional(),
        homeRoomId: id.nullish(),
        status: z.enum(["active", "withdrawn"]).optional(),
        expectedRevision: revision.optional(),
      }),
    }),
  ),
  command(
    "judge.replace",
    z.strictObject({
      oldJudgeId: id,
      newJudgeId: id.optional(),
      newName: text.optional(),
      reason,
      expectedRevision: revision.optional(),
    }),
  ),
  command("judge.revoke", z.strictObject({ judgeId: id, reason })),
  command("judge.card", z.strictObject({ judgeId: id })),
  command(
    "room.create",
    z.strictObject({ name: text, sortOrder: z.number().int().min(1).max(10000).optional() }),
  ),
  command(
    "room.update",
    z.strictObject({
      roomId: id,
      patch: z.strictObject({ name: text, expectedRevision: revision.optional() }),
    }),
  ),
  command("room.delete", z.strictObject({ roomId: id })),
  command("room.generate", z.strictObject({ count: z.number().int().min(1).max(200) })),
  command("room.panel", z.strictObject({ roomId: id, judgeIds: z.array(id).min(1).max(5) })),
  command(
    "draw.preview",
    z.strictObject({
      divisionCodes: z.array(divisionCode).min(1).max(20),
      seed: z.string().max(200).optional(),
      method: z.enum(["random", "seeded"]).optional(),
      rounds: round.optional(),
    }),
  ),
  command(
    "draw.save",
    z.strictObject({
      baseRevision: revision,
      debates: z.array(debate).max(2000),
      seed: z.string().max(200).optional(),
      ...orphanOptions,
    }),
  ),
  command(
    "draw.edit",
    z.strictObject({ baseRevision: revision, debateId: id, patch: drawPatch, ...orphanOptions }),
  ),
  command(
    "draw.swap",
    z.strictObject({
      baseRevision: revision,
      round,
      teamId: id,
      otherTeamId: id,
      ...orphanOptions,
    }),
  ),
  command("draw.publish", z.strictObject({ baseRevision: revision })),
  command("round.open", z.strictObject({ round })),
  command("round.close", z.strictObject({ round })),
  command("round.reopen", z.strictObject({ round, reason })),
  command(
    "round.motion",
    z.strictObject({ round, divisionCode, motion, expectedRevision: revision.optional() }),
  ),
  command(
    "checklist.override",
    z.strictObject({
      step: z.string().min(1).max(128),
      state: z.enum(["done", "skipped"]).nullable(),
      reason,
    }),
  ),
  command(
    "override.add",
    z.strictObject({
      divisionCode,
      kind: z.enum([
        "force_include",
        "force_exclude",
        "keep_all_for_debater",
        "exclude_debater",
        "rank_single_speaker_team",
      ]),
      speakerId: id.optional(),
      teamId: id.optional(),
      round: round.optional(),
      assignmentId: sheetId.optional(),
      reason,
    }),
  ),
  command("override.revoke", z.strictObject({ overrideId: id, reason })),
  command("sheet.waive", z.strictObject({ assignmentId: sheetId, reason })),
  command("sheet.unwaive", z.strictObject({ assignmentId: sheetId, reason })),
  command(
    "sheet.resolve",
    z.strictObject({
      conflictId: id,
      choice: z.enum(["keep", "incoming", "merge_comments"]),
      reason,
    }),
  ),
  command(
    "sheet.paper",
    z.strictObject({ assignmentId: sheetId, payload, reason, judgeNameConfirmed: z.literal(true) }),
  ),
  command(
    "sheet.correct",
    z.strictObject({ assignmentId: sheetId, baseVersion: revision, payload, reason }),
  ),
  command(
    "sheet.handoff",
    z.strictObject({
      assignmentId: sheetId,
      judgeId: id,
      requestId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
      payload,
      reason,
    }),
  ),
  command(
    "sheet.attach",
    z.strictObject({
      assignmentId: sheetId,
      successorId: sheetId,
      speakerMap: z.record(id, id),
      reason,
    }),
  ),
  command("sheet.discard", z.strictObject({ assignmentId: sheetId, reason })),
  command("results.publish", z.strictObject({ divisionCode, acknowledgePolicy: z.literal(true) })),
  command("results.reopen", z.strictObject({ divisionCode, reason })),
  command(
    "results.finalists",
    z.strictObject({ divisionCode, teamIds: z.array(id).length(2), reason }),
  ),
  command(
    "settings.update",
    z.strictObject({ patch: settingsSchema.partial(), expectedRevision: revision.optional() }),
  ),
  command("settings.policy", z.strictObject({ policy: loppingPolicySchema, reason })),
  command("simulation.room", z.strictObject({ roomId: id, round, ...simulation })),
  command(
    "simulation.round",
    z.strictObject({
      round,
      leaveMissing: z.number().int().min(0).max(1000).optional(),
      ...simulation,
    }),
  ),
  command(
    "simulation.skip",
    z.strictObject({ to: z.union([round, z.literal("results")]), ...simulation }),
  ),
  command("simulation.conflict", z.strictObject({ assignmentId: sheetId, seed: simulation.seed })),
  command("simulation.reset", z.strictObject({})),
  command(
    "tournament.duplicate",
    z.strictObject({
      name: text,
      slug: text.optional(),
      kind: z.enum(["live", "sandbox"]).optional(),
      copyTeams: z.boolean().optional(),
    }),
  ),
  command("tournament.archive", z.strictObject({})),
  command("tournament.update", z.strictObject({ name: text.optional(), slug: text.optional() })),
  command(
    "backup.restore",
    z.strictObject({ backupText: z.string().min(1).max(20_000_000), confirmSlug: text, reason }),
  ),
]);
export type OrganiserCommand = z.infer<typeof organiserCommandSchema>;

function checkInputBounds(input: unknown, depth = 0, key = "") {
  if (depth > 20) throw errors.validation("The submitted information is too deeply nested.");
  if (typeof input === "string") {
    const max = key === "backupText" ? 20_000_000 : key === "text" ? 1_000_000 : 20_000;
    if (input.length > max) throw errors.validation("The submitted text is too long.");
  } else if (Array.isArray(input)) {
    if (input.length > 2000) throw errors.validation("Too many entries were submitted.");
    for (const entry of input) checkInputBounds(entry, depth + 1, key);
  } else if (input && typeof input === "object") {
    const entries = Object.entries(input);
    if (entries.length > 2000) throw errors.validation("Too many fields were submitted.");
    for (const [field, value] of entries) checkInputBounds(value, depth + 1, field);
  }
}
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  checkInputBounds(input);
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw errors.validation("Some of the information sent is not valid.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  return parsed.data;
}
async function membershipFor(ctx: ServiceContext, organisationId: string) {
  if (ctx.actor.type !== "user") throw errors.unauthenticated();
  if (!z.uuid().safeParse(ctx.actor.id).success) throw errors.forbidden();
  const [membership] = await ctx.db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.userId, ctx.actor.id), eq(memberships.organisationId, organisationId)),
    )
    .limit(1);
  if (!membership || !["owner", "organiser"].includes(membership.role)) throw errors.forbidden();
  return membership;
}
const OWNER_COMMANDS: ReadonlySet<OrganiserCommand["action"]> = new Set([
  "judge.card",
  "judge.revoke",
  "backup.restore",
  "simulation.reset",
]);
function judgeProjection(judge: JudgeRow) {
  return {
    id: judge.id,
    name: judge.name,
    code: judge.code,
    status: judge.status,
    homeRoomId: judge.homeRoomId,
  };
}
function tournamentProjection(tournament: TournamentRow) {
  return {
    id: tournament.id,
    name: tournament.name,
    slug: tournament.slug,
    kind: tournament.kind,
    status: tournament.status,
    revision: tournament.revision,
  };
}
async function scopedJudge(db: Queryable, tournamentId: string, judgeId: string) {
  const [judge] = await db
    .select()
    .from(judges)
    .where(and(eq(judges.id, judgeId), eq(judges.tournamentId, tournamentId)))
    .limit(1);
  if (!judge) throw errors.notFound("That judge");
  return judge;
}

/** Throws AppError; callers wrap with run. The action facade never exposes thrown errors. */
export async function executeOrganiserCommand(ctx: ServiceContext, input: unknown) {
  if (ctx.actor.type !== "user") throw errors.unauthenticated();
  const cmd = parse(organiserCommandSchema, input);
  const tournament = await tournamentService.getTournamentById(ctx.db, cmd.tournamentId);
  const membership = await membershipFor(ctx, tournament.organisationId);
  if (tournament.demoExpiresAt && tournament.demoExpiresAt <= ctx.now())
    throw errors.forbidden("This demo has expired. Start a fresh demo from the home page.");
  if (
    tournament.kind === "demo" &&
    ["tournament.duplicate", "backup.restore", "tournament.archive"].includes(cmd.action)
  )
    throw errors.forbidden(
      "This temporary demo can be reset, but cannot be copied, restored or archived.",
    );
  if (OWNER_COMMANDS.has(cmd.action) && membership.role !== "owner")
    throw errors.forbidden("Only an owner of the organisation can do this.");
  const tournamentId = cmd.tournamentId;
  const tx = <T>(work: (transaction: Tx) => Promise<T>) => withTransaction(ctx, work);
  const data = await dispatch();
  return { action: cmd.action, data };

  async function dispatch() {
    switch (cmd.action) {
      case "team.create": {
        const team = await tx((t) => teamService.createTeam(t, ctx, tournamentId, cmd.data));
        return { id: team.id };
      }
      case "team.update": {
        const team = await tx((t) =>
          teamService.updateTeam(t, ctx, tournamentId, cmd.data.teamId, cmd.data.patch),
        );
        return { id: team.id };
      }
      case "team.withdraw":
        return tx((t) =>
          teamService.deleteTeam(t, ctx, tournamentId, cmd.data.teamId, {
            reason: cmd.data.reason,
          }),
        );
      case "team.import.preview":
        return teamService.importTeams(ctx.db, ctx, tournamentId, cmd.data);
      case "team.import.commit":
        return tx(async (t) => {
          const parsed = await teamService.importTeams(t, ctx, tournamentId, cmd.data);
          const result = await teamService.commitImport(t, ctx, tournamentId, parsed);
          return { teamIds: result.teams.map((team) => team.id), counts: result.counts };
        });
      case "judge.create":
        return judgeProjection(
          (await tx((t) => judgeService.createJudge(t, ctx, tournamentId, cmd.data))).judge,
        );
      case "judge.update":
        return judgeProjection(
          await tx((t) =>
            judgeService.updateJudge(t, ctx, tournamentId, cmd.data.judgeId, cmd.data.patch),
          ),
        );
      case "judge.replace": {
        const result = await tx((t) => judgeService.replaceJudge(t, ctx, tournamentId, cmd.data));
        return {
          judge: judgeProjection(result.newJudge),
          keptDebateIds: result.keptDebateIds,
          movedSheets: result.movedSheets,
        };
      }
      case "judge.revoke":
        return tx(async (t) => {
          await scopedJudge(t, tournamentId, cmd.data.judgeId);
          return revokeJudgeSessions(t, ctx, cmd.data.judgeId, cmd.data.reason);
        });
      case "judge.card":
        return tx(async (t) => {
          const judge = await scopedJudge(t, tournamentId, cmd.data.judgeId);
          const token = await issueJoinToken(t, ctx, judge.id);
          await recordAudit(t, ctx, {
            tournamentId,
            action: AUDIT_ACTIONS.judgesCardIssued,
            entityType: "judge",
            entityId: judge.id,
            after: { judgeName: judge.name },
          });
          return { ...judgeProjection(judge), link: joinLinkFor(token) };
        });
      case "room.create": {
        const room = await tx((t) => roomService.createRoom(t, ctx, tournamentId, cmd.data));
        return { id: room.id, name: room.name };
      }
      case "room.update": {
        const room = await tx((t) =>
          roomService.updateRoom(t, ctx, tournamentId, cmd.data.roomId, cmd.data.patch),
        );
        return { id: room.id, name: room.name };
      }
      case "room.delete":
        await tx((t) => roomService.deleteRoom(t, ctx, tournamentId, cmd.data.roomId));
        return { deleted: true };
      case "room.generate":
        return {
          rooms: (
            await tx((t) => roomService.generateRooms(t, ctx, tournamentId, cmd.data.count))
          ).map((room) => ({ id: room.id, name: room.name })),
        };
      case "room.panel":
        return {
          judges: (
            await tx((t) =>
              roomService.setFixedPanel(t, ctx, tournamentId, cmd.data.roomId, cmd.data.judgeIds),
            )
          ).map(judgeProjection),
        };
      case "draw.preview":
        return drawService.previewDraw(ctx.db, ctx, tournamentId, cmd.data);
      case "draw.save":
        return tx((t) => drawService.saveDraw(t, ctx, tournamentId, cmd.data));
      case "draw.edit":
        return tx((t) => drawService.editDebate(t, ctx, tournamentId, cmd.data));
      case "draw.swap":
        return tx((t) => drawService.swapTeams(t, ctx, tournamentId, cmd.data));
      case "draw.publish":
        return tx((t) => drawService.publishDraw(t, ctx, tournamentId, cmd.data));
      case "round.open": {
        const row = await tx((t) => roundService.openRound(t, ctx, tournamentId, cmd.data.round));
        return { round: row.number, status: row.status };
      }
      case "round.close": {
        const row = await tx((t) => roundService.closeRound(t, ctx, tournamentId, cmd.data.round));
        return { round: row.number, status: row.status };
      }
      case "round.reopen": {
        const row = await tx((t) =>
          roundService.reopenRound(t, ctx, tournamentId, cmd.data.round, cmd.data.reason),
        );
        return { round: row.number, status: row.status };
      }
      case "round.motion":
        return tx((t) => roundService.setMotion(t, ctx, tournamentId, cmd.data));
      case "checklist.override":
        return tx((t) =>
          setChecklistOverride(
            t,
            ctx,
            tournamentId,
            cmd.data.step,
            cmd.data.state,
            cmd.data.reason,
          ),
        );
      case "override.add": {
        const row = await overrideService.addOverride(ctx, { tournamentId, ...cmd.data });
        return { id: row.id };
      }
      case "override.revoke": {
        const row = await overrideService.revokeOverride(ctx, { tournamentId, ...cmd.data });
        return { id: row.id, revoked: true };
      }
      case "sheet.waive": {
        const row = await waiverService.waiveSheet(ctx, { tournamentId, ...cmd.data });
        return { id: row.id };
      }
      case "sheet.unwaive": {
        const row = await waiverService.unwaiveSheet(ctx, { tournamentId, ...cmd.data });
        return { id: row.id, revoked: true };
      }
      case "sheet.resolve":
        return resolveConflict(ctx, { tournamentId, ...cmd.data });
      case "sheet.paper":
        return sheetService.enterPaperSheet(ctx, { tournamentId, ...cmd.data });
      case "sheet.correct":
        return sheetService.correctSheet(ctx, { tournamentId, ...cmd.data });
      case "sheet.handoff":
        return sheetService.enterHandoff(ctx, { tournamentId, ...cmd.data });
      case "sheet.attach":
        return attachOrphan(ctx, { tournamentId, ...cmd.data });
      case "sheet.discard":
        return discardOrphan(ctx, { tournamentId, ...cmd.data });
      case "results.publish":
        return finalizeService.finalizeDivision(ctx, { tournamentId, ...cmd.data });
      case "results.reopen":
        return finalizeService.reopenDivision(ctx, { tournamentId, ...cmd.data });
      case "results.finalists":
        return confirmFinalists(ctx, { tournamentId, ...cmd.data });
      case "settings.update":
        return tx((t) =>
          updateSettings(t, ctx, tournamentId, cmd.data.patch, {
            expectedRevision: cmd.data.expectedRevision,
          }),
        );
      case "settings.policy":
        return tx((t) =>
          updateScoringPolicy(t, ctx, tournamentId, cmd.data.policy, { reason: cmd.data.reason }),
        );
      case "simulation.room":
        return simulateService.simulateRoom(ctx, { tournamentId, ...cmd.data });
      case "simulation.round":
        return simulateService.simulateRound(ctx, { tournamentId, ...cmd.data });
      case "simulation.skip":
        return simulateService.skipAhead(ctx, { tournamentId, ...cmd.data });
      case "simulation.conflict":
        return simulateService.introduceConflict(ctx, { tournamentId, ...cmd.data });
      case "simulation.reset":
        return resetSandbox(ctx, { tournamentId });
      case "tournament.duplicate":
        return tournamentProjection(
          await tx((t) => tournamentService.duplicateForNextYear(t, ctx, tournamentId, cmd.data)),
        );
      case "tournament.archive":
        return tournamentProjection(
          await tx((t) => tournamentService.archiveTournament(t, ctx, tournamentId)),
        );
      case "tournament.update":
        return tournamentProjection(
          await tx((t) => tournamentService.updateTournament(t, ctx, tournamentId, cmd.data)),
        );
      case "backup.restore": {
        let backup: unknown;
        try {
          backup = JSON.parse(cmd.data.backupText);
        } catch {
          throw errors.validation("The backup is not valid JSON.");
        }
        return restoreInPlace(ctx, {
          tournamentId,
          backup,
          confirmSlug: cmd.data.confirmSlug,
          reason: cmd.data.reason,
        });
      }
    }
  }
}
export type OrganiserCommandResult = Awaited<ReturnType<typeof executeOrganiserCommand>>;

export const createOrganiserTournamentSchema = z.strictObject({
  organisationId: id,
  name: text,
  slug: text.optional(),
  kind: z.enum(["live", "sandbox"]).optional(),
  settings: settingsSchema.optional(),
  scoringPolicy: loppingPolicySchema.optional(),
});
export async function createOrganiserTournament(ctx: ServiceContext, input: unknown) {
  const parsed = parse(createOrganiserTournamentSchema, input);
  await membershipFor(ctx, parsed.organisationId);
  const [organisation] = await ctx.db
    .select()
    .from(organisations)
    .where(eq(organisations.id, parsed.organisationId));
  if (organisation?.isDemo)
    throw errors.forbidden(
      "Start a real organisation to create additional tournaments. The public demo has one tournament.",
    );
  return tournamentProjection(
    await withTransaction(ctx, (tx) => tournamentService.createTournament(tx, ctx, parsed)),
  );
}
