import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { JudgeAssignment, JudgeBootstrap } from "@/judge/api-types";
import type { SheetPayload } from "@/domain/types";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const fixtureSpeakerIds = [11, 12, 13, 14].map(uuid);
export function judgeFixture(): JudgeBootstrap {
  const governmentTeamId = uuid(21),
    oppositionTeamId = uuid(22);
  const speakers = fixtureSpeakerIds.map((id, index) => ({
    id,
    teamId: index < 2 ? governmentTeamId : oppositionTeamId,
    side: (index < 2 ? "government" : "opposition") as "government" | "opposition",
    position: ((index % 2) + 1) as 1 | 2,
  }));
  const assignment: JudgeAssignment = {
    id: "asg_test",
    identity: {
      debateId: uuid(31),
      divisionCode: "Open",
      round: 1,
      judgeId: uuid(1),
      governmentTeamId,
      oppositionTeamId,
      speakers,
    },
    display: {
      roomName: "Room 1",
      judgeName: "Sample Judge",
      roundFormat: "prepared",
      sidesDecided: "in-advance",
      motion: "This house would protect the mangroves",
      government: {
        teamId: governmentTeamId,
        code: "O01",
        name: "Mangrove Herons",
        school: "Sample School",
      },
      opposition: {
        teamId: oppositionTeamId,
        code: "O02",
        name: "Coral Kestrels",
        school: "Fictional College",
      },
      speakers: speakers.map((row, index) => ({
        ...row,
        name: ["Amara", "Kit", "Leila", "Noel"][index],
        role: (["pm", "gm", "lo", "om"] as const)[index],
      })),
    },
    retiredAt: null,
    successorId: null,
    divisionFinalized: false,
    roundStatus: "open",
    current: null,
    openConflict: false,
  };
  return {
    judge: { id: uuid(1), name: "Sample Judge", homeRoomName: "Room 1" },
    tournament: {
      id: uuid(2),
      name: "Sample Tournament",
      slug: "sample",
      contact: null,
      rubric: DEFAULT_SETTINGS.rubric,
      timings: DEFAULT_SETTINGS.timings,
      roles: DEFAULT_SETTINGS.roles,
      feedbackRequired: false,
    },
    assignments: [assignment],
  };
}
export function fixturePayload(): SheetPayload {
  return {
    scores: Object.fromEntries(
      fixtureSpeakerIds.map((id) => [
        id,
        {
          argumentation: 24,
          rebuttal: 25,
          presentation: 24,
          poi: 3,
          overall: 78,
          www: "Clear examples",
          ebi: "Develop rebuttal",
        },
      ]),
    ),
    sideFlipped: false,
    roleSwaps: {},
  };
}
