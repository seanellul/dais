import { describe, expect, it } from "vitest";

import {
  MIN_PASSWORD_LENGTH,
  SCRYPT_PARAMS,
  dummyPasswordHash,
  hashPassword,
  parseStoredHash,
  passwordIssue,
  verifyPassword,
} from "@/server/auth/password";

const SAMPLE = "correct horse battery";

describe("hashPassword", () => {
  it("writes scrypt$N$r$p$salt$hash with the current parameters", async () => {
    const stored = await hashPassword(SAMPLE);
    const parts = stored.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(parts.slice(1, 4).map(Number)).toEqual([
      SCRYPT_PARAMS.N,
      SCRYPT_PARAMS.r,
      SCRYPT_PARAMS.p,
    ]);
    expect(parts[4]).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes as base64url
    expect(parts[5]).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes as base64url
  });

  it("salts every hash, so the same password never hashes the same way twice", async () => {
    const [a, b] = await Promise.all([hashPassword(SAMPLE), hashPassword(SAMPLE)]);
    expect(a).not.toBe(b);
  });
});

describe("verifyPassword", () => {
  it("accepts the password that produced the hash", async () => {
    const stored = await hashPassword(SAMPLE);
    await expect(verifyPassword(SAMPLE, stored)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword(SAMPLE);
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(false);
  });

  it("rejects a tampered hash", async () => {
    const stored = await hashPassword(SAMPLE);
    // The first character of the base64url hash body carries the top six
    // bits of byte 0, so changing it always changes the decoded bytes. The
    // last character ends in padding bits that decoding discards.
    const parts = stored.split("$");
    parts[5] = parts[5].startsWith("A") ? `B${parts[5].slice(1)}` : `A${parts[5].slice(1)}`;
    await expect(verifyPassword(SAMPLE, parts.join("$"))).resolves.toBe(false);
  });

  it("rejects a tampered salt", async () => {
    const stored = await hashPassword(SAMPLE);
    const parts = stored.split("$");
    parts[4] = parts[4].startsWith("A") ? `B${parts[4].slice(1)}` : `A${parts[4].slice(1)}`;
    await expect(verifyPassword(SAMPLE, parts.join("$"))).resolves.toBe(false);
  });

  it("is false, not an error, for a missing or malformed stored value", async () => {
    await expect(verifyPassword(SAMPLE, null)).resolves.toBe(false);
    await expect(verifyPassword(SAMPLE, "")).resolves.toBe(false);
    await expect(verifyPassword(SAMPLE, "bcrypt$whatever")).resolves.toBe(false);
    await expect(verifyPassword(SAMPLE, "scrypt$1$1$1$$")).resolves.toBe(false);
  });

  it("refuses parameters outside the sane bounds", () => {
    expect(parseStoredHash("scrypt$4$8$1$AAAA$BBBB")).toBeNull();
    expect(parseStoredHash(`scrypt$${2 ** 30}$8$1$AAAA$BBBB`)).toBeNull();
    expect(parseStoredHash("scrypt$32768$8$1$AAAA$BBBB")).not.toBeNull();
  });

  it("verifies with the parameters stored in the hash, not the current constants", async () => {
    const stored = await hashPassword(SAMPLE);
    const parsed = parseStoredHash(stored);
    expect(parsed?.N).toBe(SCRYPT_PARAMS.N);
    // A hash written with a lower cost still verifies once the constants rise.
    const lowCost = stored.replace(`$${SCRYPT_PARAMS.N}$`, "$1024$");
    expect(parseStoredHash(lowCost)?.N).toBe(1024);
    await expect(verifyPassword(SAMPLE, lowCost)).resolves.toBe(false); // different derivation
  });

  it("treats Unicode forms of the same text alike", async () => {
    const composed = "café au lait 1234";
    const decomposed = "café au lait 1234";
    const stored = await hashPassword(composed);
    await expect(verifyPassword(decomposed, stored)).resolves.toBe(true);
  });
});

describe("passwordIssue", () => {
  it("names the minimum length in plain words", () => {
    expect(passwordIssue("short")).toBe(
      `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
    expect(passwordIssue("x".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it("caps the length so scrypt cannot be fed a megabyte", () => {
    expect(passwordIssue("x".repeat(5000))).toMatch(/at most/);
  });
});

describe("dummyPasswordHash", () => {
  it("is a real hash that no ordinary password matches, computed once", async () => {
    const [a, b] = await Promise.all([dummyPasswordHash(), dummyPasswordHash()]);
    expect(a).toBe(b);
    expect(parseStoredHash(a)).not.toBeNull();
    await expect(verifyPassword(SAMPLE, a)).resolves.toBe(false);
  });
});
