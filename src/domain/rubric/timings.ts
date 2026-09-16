/**
 * Speaking order and time allowed for each speech, by round format.
 */
import {
  DEFAULT_ROLE_LABELS,
  type RoleKey,
  type RoleLabels,
  type RoundFormat,
  type SpeechTimings,
} from "@/domain/types";
import { ROLE_KEYS, roleLabel } from "@/domain/rubric/roles";

/** Preparation time before an impromptu debate, in minutes. */
export const IMPROMPTU_PREP_MINUTES = 15;

export interface SpeechSlot {
  /** The four roles, then "reply" for the Prime Minister's closing speech. */
  key: RoleKey | "reply";
  /** The role that gives this speech. */
  role: RoleKey;
  label: string;
  minutes: number;
}

/**
 * The five speeches in order: PM, LO, GM, OM, then the PM reply.
 */
export function speakingOrder(
  format: RoundFormat,
  timings: SpeechTimings,
  labels: RoleLabels = DEFAULT_ROLE_LABELS,
): SpeechSlot[] {
  const minutes = timings[format];
  const speeches: SpeechSlot[] = ROLE_KEYS.map((role, index) => ({
    key: role,
    role,
    label: roleLabel(role, labels),
    minutes: minutes[index],
  }));
  speeches.push({
    key: "reply",
    role: "pm",
    label: `${roleLabel("pm", labels)} reply`,
    minutes: minutes[4],
  });
  return speeches;
}

/** Total speaking time for one debate, in minutes. */
export function totalMinutes(format: RoundFormat, timings: SpeechTimings): number {
  return timings[format].reduce((sum, value) => sum + value, 0);
}
