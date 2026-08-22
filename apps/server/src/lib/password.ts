// Password hashing, without a compiled dependency.
//
// This used argon2id through @node-rs/argon2, which is a Rust addon: a `.node`
// binary. Netlify's function bundler cannot inline one, and the option that
// tells it to leave the file alone also drops the whole functions directory
// back to the previous generation, where the runtime looks for a named
// `handler` export and answers 502. There is no setting that gives both.
//
// scrypt is memory-hard, designed for exactly this, and lives in `node:crypto`
// — nothing to bundle, nothing to install, nothing to go wrong on a platform
// nobody tested. The parameters below cost about 32MB and a tenth of a second
// per hash, which is the point: it is what makes guessing expensive.
//
// Stored as `scrypt$N$r$p$salt$hash`, parameters included, so raising the cost
// later does not strand the passwords hashed today.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Cost. 128 * N * r bytes of memory — 32MB here. */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
/** Node's default ceiling is exactly 32MB, which this sits on. Raised to clear it. */
const MAXMEM = 128 * N * R * 2;

const PREFIX = 'scrypt';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [PREFIX, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Whether this password produces that hash.
 *
 * Returns false rather than throwing on anything it cannot read — a malformed
 * row, or a leftover argon2 hash from before this module existed. A stored
 * value nobody can verify is a password nobody can use, which is the correct
 * outcome, and not a crash on the login path.
 */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hash could otherwise name a cost large enough to hang the process.
  if (n > N * 4 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: Math.max(MAXMEM, 128 * n * r * 2),
    });
    // Lengths already match by construction; compared in constant time so the
    // answer does not leak how much of the hash was right.
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * A syntactically valid hash that no password matches.
 *
 * Verified against when the account does not exist, so a wrong email and a
 * wrong password cost the same and cannot be told apart by timing. The salt is
 * fixed and the digest is arbitrary — the work happens either way, which is
 * the only property that matters here.
 */
export const DECOY_HASH = [
  PREFIX,
  N,
  R,
  P,
  Buffer.alloc(SALT_LENGTH, 0x64).toString('base64'),
  Buffer.alloc(KEY_LENGTH, 0x7f).toString('base64'),
].join('$');
