import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt parameters. N is the work factor and dominates the cost; these are
// the values Node's own documentation uses as a sane interactive baseline
// (~100ms on a modern core). maxmem must be raised to match, or scrypt
// refuses to run at this N.
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Minimum accepted password length. Enforced server-side, not just in the UI. */
export const MIN_PASSWORD_LENGTH = 8;

export interface PasswordRecord {
  hash: string;
  salt: string;
}

/** Hashes a password with a fresh random salt. */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return { hash: derived.toString("hex"), salt: salt.toString("hex") };
}

/**
 * Verifies a password against a stored record.
 *
 * The comparison is timing-safe: a plain `===` on the hex strings leaks, in
 * how long it takes to fail, how many leading characters were right — which
 * is enough to recover a hash byte by byte.
 *
 * An account with no password set (one created before local auth, or via an
 * admin invite) returns false rather than throwing, so a login attempt
 * against it is a normal failure and not an error the caller must special-case.
 */
export async function verifyPassword(
  password: string,
  record: { hash: string | null; salt: string | null },
): Promise<boolean> {
  if (!record.hash || !record.salt) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(record.hash, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const derived = await scrypt(password, Buffer.from(record.salt, "hex"), KEY_LENGTH, PARAMS);
  return timingSafeEqual(derived, expected);
}

/**
 * Burns roughly the same time as a real verification, for a login against an
 * address that has no account.
 *
 * Without this, "unknown email" returns in microseconds while "wrong
 * password" takes ~100ms, and the difference tells an attacker which
 * addresses are registered.
 */
export async function fakeVerifyDelay(): Promise<void> {
  await scrypt("timing-equalisation", randomBytes(SALT_LENGTH), KEY_LENGTH, PARAMS);
}
