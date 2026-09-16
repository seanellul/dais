import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, auditLog, memberships } from "@/server/db";
import { executeOrganiserCommand, createOrganiserTournament } from "@/server/organiser-commands";
import { run, loadGraph } from "@/server/services";
import { simulateSheet } from "@/domain/sample";
import { WORKBOOK_SAFE_POLICY } from "@/domain/scoring";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { receiveSheet } from "@/server/services/sheets";
import { seedSample, seedTournament, silentLogger, testContext } from "./helpers";

async function fixture() {
  const db = await getDb();
  const seeded = await seedTournament(db);
  const ctx = testContext(db, {
    actor: { type: "user", id: seeded.userId, name: "Sample Organiser" },
    log: silentLogger,
  });
  return {
    db,
    seeded,
    ctx,
    command: (action: string, data: unknown = {}) =>
      executeOrganiserCommand(ctx, { tournamentId: seeded.tournamentId, action, data }),
  };
}

describe("organiser commands", () => {
  it("rejects non-users, missing membership and a foreign tournament", async () => {
    const { db, seeded, ctx } = await fixture();
    const input = {
      tournamentId: seeded.tournamentId,
      action: "room.generate",
      data: { count: 2 },
    };
    await expect(executeOrganiserCommand(testContext(db), input)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(
      executeOrganiserCommand({ ...ctx, actor: { ...ctx.actor, id: randomUUID() } }, input),
    ).rejects.toMatchObject({ code: "forbidden" });
    const other = await seedTournament(db);
    await expect(
      executeOrganiserCommand(ctx, { ...input, tournamentId: other.tournamentId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("runs CRUD with audited changes and safe projections", async () => {
    const { db, seeded, command } = await fixture();
    const created = await command("team.create", {
      divisionCode: "Open",
      name: "Sample Team",
      school: "Sample School",
      speakers: [
        { position: 1, name: "Alex Sample" },
        { position: 2, name: "Jamie Sample" },
      ],
    });
    expect(created).toMatchObject({ action: "team.create", data: { id: expect.any(String) } });
    const teamId = (created.data as { id: string }).id;
    await command("team.update", { teamId, patch: { name: "Renamed Team" } });
    expect(await command("team.withdraw", { teamId, reason: "Unable to attend." })).toMatchObject({
      action: "team.withdraw",
      data: { status: "deleted" },
    });
    const judge = await command("judge.create", { name: "Sample Judge" });
    expect(JSON.stringify(judge)).not.toMatch(/joinToken|password|Hash/);
    const actions = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tournamentId, seeded.tournamentId));
    expect(actions.length).toBeGreaterThanOrEqual(4);
  });

  it("does not allow child ids from another tenant, including card issuance", async () => {
    const { db, ctx, seeded, command } = await fixture();
    const other = await seedTournament(db);
    const roster = await seedSample(db, other.tournamentId, {
      open: 2,
      novice: 2,
      rooms: 2,
      judgesPerRoom: 1,
    });
    for (const [action, data] of [
      ["judge.card", { judgeId: roster.judges[0].id }],
      ["judge.revoke", { judgeId: roster.judges[0].id, reason: "Lost phone." }],
      ["room.update", { roomId: roster.rooms[0].id, patch: { name: "Foreign room" } }],
      ["team.update", { teamId: roster.teams[0].id, patch: { name: "Foreign team" } }],
    ] as const)
      await expect(command(action, data)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      executeOrganiserCommand(ctx, {
        tournamentId: seeded.tournamentId,
        action: "judge.create",
        data: { name: "Intruder", homeRoomId: roster.rooms[0].id },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("checks validation without coercing numeric text or allowing blank reasons", async () => {
    const { command, ctx, seeded } = await fixture();
    await expect(command("room.generate", { count: "2" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      command("sheet.waive", { assignmentId: "asg_sample", reason: " " }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      command("team.import.commit", { teams: [], text: "School\tTeam\tDebater" }),
    ).rejects.toMatchObject({ code: "validation" });
    const result = await run(ctx, () =>
      executeOrganiserCommand(ctx, {
        tournamentId: seeded.tournamentId,
        action: "unknown",
        data: {},
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation", requestId: ctx.requestId },
    });
  });

  it("reparses import text on commit and rejects invalid pasted data", async () => {
    const { command } = await fixture();
    const text =
      "School\tDebater\tTeam\nSample School\tAlex Sample\tBlue\nSample School\tJamie Sample\tBlue";
    const preview = await command("team.import.preview", { text, divisionCode: "Open" });
    expect(preview).toMatchObject({ action: "team.import.preview", data: { ok: true } });
    expect(await command("team.import.commit", { text, divisionCode: "Open" })).toMatchObject({
      data: { counts: { teams: 1, debaters: 2 } },
    });
    await expect(
      command("team.import.commit", { text: "", divisionCode: "Open" }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses a stale draw save and runs round open/close", async () => {
    const { db, seeded, command } = await fixture();
    await seedSample(db, seeded.tournamentId, { open: 4, novice: 4, rooms: 4, judgesPerRoom: 3 });
    const preview = await command("draw.preview", {
      divisionCodes: ["Open", "Novice"],
      seed: "COMMANDS",
      method: "random",
    });
    const debates = (preview.data as { debates: unknown[] }).debates;
    await command("draw.save", { baseRevision: 0, debates });
    await expect(command("draw.save", { baseRevision: 0, debates })).rejects.toMatchObject({
      code: "setup_stale",
    });
    expect(await command("round.open", { round: 1 })).toMatchObject({ data: { status: "open" } });
    expect(await command("round.close", { round: 1 })).toMatchObject({
      data: { status: "closed" },
    });
  });

  it("reserves judge cards and backup restore for owners while organisers run ordinary setup", async () => {
    const { db, seeded, command } = await fixture();
    const judge = await command("judge.create", { name: "Sample Judge" });
    await db
      .update(memberships)
      .set({ role: "organiser" })
      .where(
        and(
          eq(memberships.userId, seeded.userId),
          eq(memberships.organisationId, seeded.organisationId),
        ),
      );
    await expect(
      command("judge.card", { judgeId: (judge.data as { id: string }).id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      command("backup.restore", {
        backupText: "{}",
        confirmSlug: seeded.slug,
        reason: "Restore practice.",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await command("room.generate", { count: 1 })).toMatchObject({ action: "room.generate" });
  });

  it("rejects stale settings edits even when no draw refresh is needed", async () => {
    const { command } = await fixture();
    await expect(
      command("settings.update", { patch: { feedbackRequired: true }, expectedRevision: 99 }),
    ).rejects.toMatchObject({ code: "setup_stale" });
  });

  it("wires manual sheets, handoff comment resolution, overrides and results publication", async () => {
    const { db, seeded, ctx, command } = await fixture();
    await seedSample(db, seeded.tournamentId, { open: 4, novice: 4, rooms: 4, judgesPerRoom: 3 });
    const preview = await command("draw.preview", {
      divisionCodes: ["Open", "Novice"],
      seed: "COMMAND-FLOW",
    });
    const debates = (
      preview.data as {
        debates: Array<{
          divisionCode: string;
          round: number;
          roomId: string;
          governmentTeamId: string;
          oppositionTeamId: string;
          judgeIds: string[];
          motion?: string;
        }>;
      }
    ).debates.map((d) => ({
      divisionCode: d.divisionCode,
      round: d.round,
      roomId: d.roomId,
      governmentTeamId: d.governmentTeamId,
      oppositionTeamId: d.oppositionTeamId,
      judgeIds: d.judgeIds,
      motion: d.motion,
    }));
    await command("draw.save", { baseRevision: 0, debates });
    const graph = await loadGraph(db, seeded.tournamentId);
    const [paper, handoff, missing] = graph.assignments.filter(
      (a) => a.identity.divisionCode === "Open" && a.identity.round === 1,
    );
    const payloadFor = (seat: typeof paper) =>
      simulateSheet({
        seed: "command-sheet",
        assignmentDisplay: seat.display,
        rubric: DEFAULT_SETTINGS.rubric,
        judgeId: seat.judgeId,
        rogueChance: 0,
      });
    const payload = payloadFor(paper);
    await command("sheet.paper", {
      assignmentId: paper.id,
      payload,
      reason: "Typed from paper.",
      judgeNameConfirmed: true,
    });
    const speakerId = paper.identity.speakers[0].id;
    const corrected = {
      ...payload,
      scores: {
        ...payload.scores,
        [speakerId]: {
          ...payload.scores[speakerId],
          overall: payload.scores[speakerId].overall - 1,
        },
      },
    };
    expect(
      await command("sheet.correct", {
        assignmentId: paper.id,
        baseVersion: 1,
        payload: corrected,
        reason: "Confirmed transcription typo.",
      }),
    ).toMatchObject({ data: { version: 2 } });
    const override = await command("override.add", {
      divisionCode: "Open",
      kind: "force_include",
      speakerId,
      assignmentId: paper.id,
      reason: "Confirmed score.",
    });
    await command("override.revoke", {
      overrideId: (override.data as { id: string }).id,
      reason: "Keep normal policy.",
    });
    await command("sheet.waive", { assignmentId: missing.id, reason: "No paper arrived." });
    await command("sheet.unwaive", { assignmentId: missing.id, reason: "Judge returned." });
    const phonePayload = payloadFor(handoff);
    const numbersOnly = {
      ...phonePayload,
      scores: Object.fromEntries(
        Object.entries(phonePayload.scores).map(([id, s]) => [id, { ...s, www: "", ebi: "" }]),
      ),
    };
    await command("sheet.handoff", {
      assignmentId: handoff.id,
      judgeId: handoff.judgeId,
      requestId: "command-handoff",
      payload: numbersOnly,
      reason: "No signal.",
    });
    const conflict = await receiveSheet(ctx, {
      tournamentId: seeded.tournamentId,
      judgeId: handoff.judgeId,
      assignmentId: handoff.id,
      requestId: "command-handoff",
      baseVersion: 0,
      payload: phonePayload,
    });
    if (conflict.status !== "conflict") throw new Error("Expected feedback for merging");
    expect(
      await command("sheet.resolve", {
        conflictId: conflict.conflictId,
        choice: "merge_comments",
        reason: "Add phone feedback.",
      }),
    ).toMatchObject({ data: { version: 2 } });
    await command("settings.policy", {
      policy: WORKBOOK_SAFE_POLICY,
      reason: "Use safe practice policy.",
    });
    await command("simulation.skip", { to: "results", seed: "command-finish", rogueChance: 0 });
    expect(
      await command("results.publish", { divisionCode: "Open", acknowledgePolicy: true }),
    ).toMatchObject({ data: { divisionCode: "Open", snapshotId: expect.any(String) } });
    expect(
      await command("results.reopen", {
        divisionCode: "Open",
        reason: "Check publication practice.",
      }),
    ).toMatchObject({ data: { divisionCode: "Open" } });
  });

  it("creates tournaments only inside a current membership organisation", async () => {
    const { db, ctx, seeded } = await fixture();
    const other = await seedTournament(db);
    await expect(
      createOrganiserTournament(ctx, {
        organisationId: other.organisationId,
        name: "Foreign Tournament",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const created = await createOrganiserTournament(ctx, {
      organisationId: seeded.organisationId,
      name: "Another Sample Tournament",
    });
    expect(created).toMatchObject({ id: expect.any(String), name: "Another Sample Tournament" });
    expect(JSON.stringify(created)).not.toMatch(/joinCode|Hash|secret/);
  });
});
