/**
 * Organiser passwords: scrypt from `node:crypto`, no native dependency.
 *
 * A stored hash looks like `scrypt$32768$8$1$<salt>$<hash>` (salt and hash
 * as base64url). The parameters travel with the hash so they can be raised
 * later without breaking existing accounts: `verifyPassword` reads them back
 * from the stored string rather than from the constants.
 *
 * Verification compares with `timingSafeEqual`, and a sign-in for an unknown
 * email still runs one scrypt against a dummy hash (`dummyPasswordHash`) so
 * the response time does not reveal which emails have accounts.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/** The cost parameters new hashes are written with. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;

const ALGORITHM = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** 128 * N * r bytes for the parameters above, with room for a later N. */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/** The shortest password the service layer accepts. */
export const MIN_PASSWORD_LENGTH = 10;
/** scrypt cost grows with input length; a cap keeps a hostile form cheap. */
export const MAX_PASSWORD_LENGTH = 200;

/** Sane bounds when reading parameters back from a stored hash. */
const PARAM_BOUNDS = { N: [2 ** 10, 2 ** 20], r: [1, 32], p: [1, 16] } as const;

interface StoredHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/**
 * Returns a plain sentence when the password is not acceptable, or null when
 * it is. Services throw `errors.validation` with this message.
 */
export function passwordIssue(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use a password of at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/** Hashes a password for storage in `users.password_hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return [ALGORITHM, N, r, p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

/**
 * True when `password` produced `stored`. A malformed or missing stored
 * value is simply false, never an exception, so an account created by an
 * invite that was never accepted (null hash) fails sign-in quietly.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parsed = stored ? parseStoredHash(stored) : null;
  if (!parsed) return false;
  try {
    const candidate = await derive(password, parsed.salt, parsed);
    return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
  } catch {
    // Parameters beyond the memory cap, or an input scrypt refuses.
    return false;
  }
}

/** Splits a stored hash into its parts, or returns null when it is not one of ours. */
export function parseStoredHash(stored: string): StoredHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return null;
  const [, nText, rText, pText, saltText, hashText] = parts;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!withinBounds(N, PARAM_BOUNDS.N) || !withinBounds(r, PARAM_BOUNDS.r)) return null;
  if (!withinBounds(p, PARAM_BOUNDS.p)) return null;
  const salt = Buffer.from(saltText, "base64url");
  const hash = Buffer.from(hashText, "base64url");
  if (salt.length === 0 || hash.length === 0) return null;
  return { N, r, p, salt, hash };
}

let dummyHash: Promise<string> | undefined;

/**
 * A real hash of a password nobody uses. Sign-in verifies against it when
 * the email is unknown, so both paths cost one scrypt.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("dais-dummy-password-for-timing");
  return dummyHash;
}

function withinBounds(value: number, [min, max]: readonly [number, number]): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** `node:crypto`'s callback scrypt as a promise, with the options overload. */
function derive(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  const options = { ...params, maxmem: MAX_MEMORY_BYTES };
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, KEY_BYTES, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
