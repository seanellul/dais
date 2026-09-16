/**
 * Drizzle relations for the relational query API (`db.query.<table>`).
 * Relations describe how to join; they add nothing to the SQL schema.
 * Only the joins the organiser screens and services need are declared here.
 */
import { relations } from "drizzle-orm";
import {
  assignments,
  conflicts,
  debateJudges,
  debateTeams,
  debates,
  divisions,
  judges,
  memberships,
  organisations,
  rooms,
  rounds,
  sheetVersions,
  sheets,
  speakers,
  teams,
  tournaments,
  users,
} from "./schema";

export const organisationsRelations = relations(organisations, ({ many }) => ({
  tournaments: many(tournaments),
  memberships: many(memberships),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  organisation: one(organisations, {
    fields: [memberships.organisationId],
    references: [organisations.id],
  }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export const tournamentsRelations = relations(tournaments, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [tournaments.organisationId],
    references: [organisations.id],
  }),
  divisions: many(divisions),
  rooms: many(rooms),
  rounds: many(rounds),
  teams: many(teams),
  judges: many(judges),
  debates: many(debates),
  assignments: many(assignments),
}));

export const divisionsRelations = relations(divisions, ({ one, many }) => ({
  tournament: one(tournaments, { fields: [divisions.tournamentId], references: [tournaments.id] }),
  teams: many(teams),
  debates: many(debates),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  tournament: one(tournaments, { fields: [rooms.tournamentId], references: [tournaments.id] }),
  debates: many(debates),
  homeJudges: many(judges),
}));

export const roundsRelations = relations(rounds, ({ one }) => ({
  tournament: one(tournaments, { fields: [rounds.tournamentId], references: [tournaments.id] }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  tournament: one(tournaments, { fields: [teams.tournamentId], references: [tournaments.id] }),
  division: one(divisions, {
    fields: [teams.tournamentId, teams.divisionCode],
    references: [divisions.tournamentId, divisions.code],
  }),
  speakers: many(speakers),
}));

export const speakersRelations = relations(speakers, ({ one }) => ({
  team: one(teams, { fields: [speakers.teamId], references: [teams.id] }),
}));

export const judgesRelations = relations(judges, ({ one, many }) => ({
  tournament: one(tournaments, { fields: [judges.tournamentId], references: [tournaments.id] }),
  homeRoom: one(rooms, { fields: [judges.homeRoomId], references: [rooms.id] }),
  panels: many(debateJudges),
  assignments: many(assignments),
}));

export const debatesRelations = relations(debates, ({ one, many }) => ({
  tournament: one(tournaments, { fields: [debates.tournamentId], references: [tournaments.id] }),
  division: one(divisions, {
    fields: [debates.tournamentId, debates.divisionCode],
    references: [divisions.tournamentId, divisions.code],
  }),
  room: one(rooms, { fields: [debates.roomId], references: [rooms.id] }),
  governmentTeam: one(teams, {
    fields: [debates.governmentTeamId],
    references: [teams.id],
    relationName: "government",
  }),
  oppositionTeam: one(teams, {
    fields: [debates.oppositionTeamId],
    references: [teams.id],
    relationName: "opposition",
  }),
  sides: many(debateTeams),
  panel: many(debateJudges),
  assignments: many(assignments),
}));

export const debateTeamsRelations = relations(debateTeams, ({ one }) => ({
  debate: one(debates, { fields: [debateTeams.debateId], references: [debates.id] }),
  team: one(teams, { fields: [debateTeams.teamId], references: [teams.id] }),
}));

export const debateJudgesRelations = relations(debateJudges, ({ one }) => ({
  debate: one(debates, { fields: [debateJudges.debateId], references: [debates.id] }),
  judge: one(judges, { fields: [debateJudges.judgeId], references: [judges.id] }),
}));

export const assignmentsRelations = relations(assignments, ({ one, many }) => ({
  tournament: one(tournaments, {
    fields: [assignments.tournamentId],
    references: [tournaments.id],
  }),
  debate: one(debates, { fields: [assignments.debateId], references: [debates.id] }),
  judge: one(judges, { fields: [assignments.judgeId], references: [judges.id] }),
  sheet: one(sheets, {
    fields: [assignments.tournamentId, assignments.id],
    references: [sheets.tournamentId, sheets.assignmentId],
  }),
  versions: many(sheetVersions),
  conflicts: many(conflicts),
}));

export const sheetsRelations = relations(sheets, ({ one }) => ({
  assignment: one(assignments, {
    fields: [sheets.tournamentId, sheets.assignmentId],
    references: [assignments.tournamentId, assignments.id],
  }),
  currentVersion: one(sheetVersions, {
    fields: [sheets.currentVersionId],
    references: [sheetVersions.id],
  }),
}));

export const sheetVersionsRelations = relations(sheetVersions, ({ one }) => ({
  assignment: one(assignments, {
    fields: [sheetVersions.tournamentId, sheetVersions.assignmentId],
    references: [assignments.tournamentId, assignments.id],
  }),
}));

export const conflictsRelations = relations(conflicts, ({ one }) => ({
  assignment: one(assignments, {
    fields: [conflicts.tournamentId, conflicts.assignmentId],
    references: [assignments.tournamentId, assignments.id],
  }),
  judge: one(judges, { fields: [conflicts.judgeId], references: [judges.id] }),
}));
