/**
 * Ids, codes, tokens and hashes for the server.
 *
 * Codes that people read aloud or type (join codes, judge codes, draw seeds)
 * use the Crockford base32 alphabet, which leaves out I, L, O and U so that
 * 0/O and 1/I/L cannot be confused on a printed card. Secrets (session and
 * join tokens) are random bytes as base64url and are stored only as hashes.
 */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

import { canonicalJson } from "@/domain/schedule";
import { getEnv } from "@/server/env";

/** Crockford base32: digits and letters without I, L, O and U. 32 symbols. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The 22 letters of the Crockford alphabet, for codes that start with letters. */
export const CROCKFORD_LETTERS = "ABCDEFGHJKMNPQRSTVWXYZ";

/** A join code: four Crockford letters then two digits, e.g. "KRWP47". */
export const JOIN_CODE_PATTERN = /^[A-HJKMNP-TV-Z]{4}[0-9]{2}$/;

/** A fresh uuid for a primary key. */
export function newId(): string {
  return randomUUID();
}

/**
 * A random Crockford base32 code of `length` symbols. Each byte picks one of
 * 32 symbols (32 divides 256), so every symbol is equally likely.
 */
export function crockfordCode(length = 6): string {
  let code = "";
  for (const byte of randomBytes(length)) code += CROCKFORD_ALPHABET[byte & 31];
  return code;
}

/**
 * A tournament join code: four Crockford letters and two digits, six symbols
 * a judge can type from a printed card. Uniqueness per tournament is the
 * database's job (`tournaments_join_code_unique`); retry on a clash.
 */
export function joinCode(): string {
  let code = "";
  for (let i = 0; i < 4; i += 1) code += CROCKFORD_LETTERS[randomInt(CROCKFORD_LETTERS.length)];
  for (let i = 0; i < 2; i += 1) code += String(randomInt(10));
  return code;
}

/**
 * Cleans a code someone typed: trims, upper-cases, drops spaces and dashes,
 * and maps the letters the alphabet leaves out to the digits they look like
 * (O to 0, I and L to 1). Use it before comparing a typed join code.
 */
export function normaliseCode(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** A random secret as base64url, safe in a URL or QR code. 24 bytes gives 32 characters. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Lower-case hex sha256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The stored form of a session or join token: sha256 over the secret and the
 * token. The secret is a pepper, so a copy of the database alone cannot be
 * used to forge a token. Changing SESSION_SECRET signs everyone out.
 */
export function hashToken(token: string): string {
  return sha256Hex(`${getEnv().SESSION_SECRET}:${token}`);
}

/**
 * A content fingerprint: sha256 over the canonical JSON of `value`, so the
 * same content gives the same fingerprint whatever the key order. Used for
 * idempotency receipts and assignment identity hashes.
 */
export function fingerprintOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
