import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalJson } from "@/domain/schedule";

/** Rebuilds the value with object keys in reverse order at every level. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .reverse()
      .map((key) => [key, reverseKeys((value as Record<string, unknown>)[key])] as const);
    // Object.fromEntries defines own properties, so a "__proto__" key stays a key.
    return Object.fromEntries(entries);
  }
  return value;
}

describe("canonicalJson", () => {
  it("sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("does not depend on key order, and parses back to the same value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = canonicalJson(value);
        expect(canonicalJson(reverseKeys(value))).toBe(text);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      { numRuns: 200 },
    );
  });

  it("matches JSON.stringify for undefined, non-finite numbers and toJSON", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, () => 1, Symbol("x")])).toBe("[null,null,null]");
    expect(canonicalJson({ n: Number.NaN, i: Infinity })).toBe('{"i":null,"n":null}');
    expect(canonicalJson(new Date(Date.UTC(2026, 0, 2)))).toBe('"2026-01-02T00:00:00.000Z"');
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(BigInt(10))).toBe('"10"');
  });
});
