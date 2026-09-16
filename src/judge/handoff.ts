import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import type { SheetPayload } from "@/domain/types";

const identifier = z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/);
const compactSchema = z.object({
  a: identifier,
  j: z.uuid(),
  q: identifier,
  v: z.number().int().min(0),
  n: z
    .array(
      z.tuple([
        z.uuid(),
        z.tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ]),
      ]),
    )
    .length(4),
  s: z.boolean(),
  r: z.record(z.uuid(), z.boolean()),
});
export interface Handoff {
  assignmentId: string;
  judgeId: string;
  requestId: string;
  baseVersion: number;
  payload: SheetPayload;
}
function check(body: string) {
  const digest = sha256(new TextEncoder().encode(body));
  const number = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0);
  return String(number % 1_000_000).padStart(6, "0");
}
export function encodeHandoff(input: Handoff): { text: string; code: string } {
  const compact = compactSchema.parse({
    a: input.assignmentId,
    j: input.judgeId,
    q: input.requestId,
    v: input.baseVersion,
    n: Object.entries(input.payload.scores)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, score]) => [
        id,
        [score.argumentation, score.rebuttal, score.presentation, score.poi, score.overall],
      ]),
    s: input.payload.sideFlipped,
    r: input.payload.roleSwaps,
  });
  const body = JSON.stringify(compact);
  const code = check(body);
  const bytes = new TextEncoder().encode(body);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return { text: `DAIS1.${code}.${encoded}`, code };
}
export function decodeHandoff(text: string): Handoff {
  if (text.length > 10_000) throw new Error("That hand-off is too long.");
  const [prefix, code, encoded, extra] = text.trim().split(".");
  if (prefix !== "DAIS1" || !/^\d{6}$/.test(code ?? "") || !encoded || extra !== undefined)
    throw new Error("Paste the complete Dais hand-off code.");
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
        character.charCodeAt(0),
      ),
    );
  } catch {
    throw new Error("The hand-off could not be read. Copy it again from the phone.");
  }
  if (check(body) !== code)
    throw new Error("The check code does not match. Copy the hand-off again.");
  const compact = compactSchema.parse(JSON.parse(body));
  if (new Set(compact.n.map(([id]) => id)).size !== 4)
    throw new Error("The hand-off must name four different debaters.");
  return {
    assignmentId: compact.a,
    judgeId: compact.j,
    requestId: compact.q,
    baseVersion: compact.v,
    payload: {
      scores: Object.fromEntries(
        compact.n.map(([id, values]) => [
          id,
          {
            argumentation: values[0],
            rebuttal: values[1],
            presentation: values[2],
            poi: values[3],
            overall: values[4],
            www: "",
            ebi: "",
          },
        ]),
      ),
      sideFlipped: compact.s,
      roleSwaps: compact.r,
    },
  };
}
export function handoffComments(payload: SheetPayload, names: Record<string, string>): string {
  return Object.entries(payload.scores)
    .map(
      ([id, score]) =>
        `${names[id] ?? id}\nWhat went well: ${score.www}\nEven better if: ${score.ebi}`,
    )
    .join("\n\n");
}
