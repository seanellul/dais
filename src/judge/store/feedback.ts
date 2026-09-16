import type { LocalPayload } from "./types";
/** Unchanged comment inputs represent empty text, while numeric fields remain incomplete. */
export function withBlankFeedback(payload: LocalPayload): LocalPayload {
  return {
    ...payload,
    scores: Object.fromEntries(
      Object.entries(payload.scores).map(([id, score]) => [
        id,
        { ...score, www: score.www ?? "", ebi: score.ebi ?? "" },
      ]),
    ),
  };
}
