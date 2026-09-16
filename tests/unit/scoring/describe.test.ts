import { describe, expect, it } from "vitest";
import {
  WORKBOOK_POLICY,
  WORKBOOK_SAFE_POLICY,
  canonicalPolicyJson,
  describePolicy,
  describeRoundReason,
  policyEquals,
  type LoppingPolicy,
} from "@/domain/scoring";

/** One sentence: ends with a full stop and has no sentence break inside. */
function isOneSentence(text: string): boolean {
  return text.endsWith(".") && !text.slice(0, -1).includes(". ");
}

describe("describePolicy", () => {
  it("describes the workbook policy in one sentence using the tournament vocabulary", () => {
    const text = describePolicy(WORKBOOK_POLICY);
    expect(isOneSentence(text)).toBe(true);
    for (const word of ["average", "spread", "set aside", "kept range", "can't be scored yet"]) {
      expect(text).toContain(word);
    }
    expect(text).toContain("all of a debater's scores from every round");
    expect(text).toContain("on or outside");
    expect(text).toContain("once");
    expect(text).toContain("15 significant digits");
    for (const banned of [
      "mean",
      "standard deviation",
      "lopped",
      "excluded",
      "unresolved",
      "bounds",
    ]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });

  it("says that the safe policy keeps all scores in the edge cases", () => {
    const text = describePolicy(WORKBOOK_SAFE_POLICY);
    expect(isOneSentence(text)).toBe(true);
    expect(text).toContain("keeps all of them");
    expect(text).not.toContain("can't be scored yet");
  });

  it("describes every other knob", () => {
    const policy: LoppingPolicy = {
      sdMultiplier: 1.5,
      bounds: "inclusive",
      scope: "perRound",
      passes: "iterative",
      sd: "population",
      whenUndefined: "keepAll",
      zeroSpread: "unresolved",
      excelCriteriaRounding: false,
    };
    const text = describePolicy(policy);
    expect(isOneSentence(text)).toBe(true);
    expect(text).toContain("1.5 × spread");
    expect(text).toContain("population spread");
    expect(text).toContain("each round's scores separately");
    expect(text).toContain("scores outside the kept range");
    expect(text).toContain("until nothing more is set aside");
    expect(text).toContain("fewer than two scores keeps all of them");
    expect(text).toContain("every score the same can't be scored yet");
    expect(text).not.toContain("Excel");
  });
});

describe("describeRoundReason", () => {
  it("names the round and uses plain words", () => {
    expect(describeRoundReason(2, "sheet_missing")).toBe(
      "Round 2: a sheet has not been received by the tournament yet.",
    );
    expect(describeRoundReason(3, "no_retained_scores")).toContain("set aside");
    expect(describeRoundReason(1, "zero_spread")).toContain("spread is zero");
  });
});

describe("policyEquals and canonicalPolicyJson", () => {
  it("compares knob by knob and ignores key order", () => {
    const reordered = { ...WORKBOOK_POLICY, excelCriteriaRounding: true, sdMultiplier: 2 };
    expect(policyEquals(WORKBOOK_POLICY, reordered)).toBe(true);
    expect(policyEquals(WORKBOOK_POLICY, WORKBOOK_SAFE_POLICY)).toBe(false);
    expect(canonicalPolicyJson(reordered)).toBe(canonicalPolicyJson(WORKBOOK_POLICY));
    expect(canonicalPolicyJson(WORKBOOK_POLICY)).toBe(
      '{"sdMultiplier":2,"bounds":"strict","scope":"pooled","passes":"one","sd":"sample","whenUndefined":"unresolved","zeroSpread":"unresolved","excelCriteriaRounding":true}',
    );
  });
});
