import type { AssignmentDisplay, SheetPayload, SpeakerScore } from "@/domain/types";

export const SPEAKER_IDS = ["spk-o01-1", "spk-o01-2", "spk-o02-1", "spk-o02-2"];

export const DISPLAY: AssignmentDisplay = {
  roomName: "Room 1",
  judgeName: "Marisol Blake",
  roundFormat: "prepared",
  sidesDecided: "in-advance",
  motion: "This House would make every school day start at ten o'clock.",
  government: {
    teamId: "team-o01",
    code: "O01",
    name: "Coral Bay Compass",
    school: "Coral Bay Academy",
  },
  opposition: {
    teamId: "team-o02",
    code: "O02",
    name: "Harbourview Lantern",
    school: "Harbourview College",
  },
  speakers: [
    {
      id: "spk-o01-1",
      name: "Amara Bennett",
      teamId: "team-o01",
      side: "government",
      position: 1,
      role: "pm",
    },
    {
      id: "spk-o01-2",
      name: "Theo Campbell",
      teamId: "team-o01",
      side: "government",
      position: 2,
      role: "gm",
    },
    {
      id: "spk-o02-1",
      name: "Leila Foster",
      teamId: "team-o02",
      side: "opposition",
      position: 1,
      role: "lo",
    },
    {
      id: "spk-o02-2",
      name: "Marcus Grant",
      teamId: "team-o02",
      side: "opposition",
      position: 2,
      role: "om",
    },
  ],
};

export function score(overall: number, extra: Partial<SpeakerScore> = {}): SpeakerScore {
  return {
    argumentation: 26,
    rebuttal: 25,
    presentation: 27,
    poi: 3,
    overall,
    www: "Clear signposting made the case easy to follow.",
    ebi: "Slow down slightly in the final minute.",
    ...extra,
  };
}

export function fullPayload(): SheetPayload {
  return {
    scores: {
      "spk-o01-1": score(82),
      "spk-o01-2": score(78),
      "spk-o02-1": score(80),
      "spk-o02-2": score(84),
    },
    sideFlipped: false,
    roleSwaps: {},
  };
}
