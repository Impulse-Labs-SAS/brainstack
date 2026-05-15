// Crypto helpers for token generation and hashing.
// We never persist plaintext tokens — only sha256 hashes.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Generate a URL-safe random token of `bytes` bytes (default 32 = 64 hex chars). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string compare. Both strings are first lowercased + utf8-encoded. */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const buf1 = Buffer.from(a, 'utf8');
  const buf2 = Buffer.from(b, 'utf8');
  if (buf1.length !== buf2.length) return false;
  return timingSafeEqual(buf1, buf2);
}
