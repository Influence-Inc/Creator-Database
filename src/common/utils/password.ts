/**
 * Password hashing for user accounts (scouts + any DB-backed admin).
 *
 * Uses scrypt from node's crypto — deliberately no new dependency, and scrypt
 * is memory-hard so it stands up to GPU cracking far better than a plain hash.
 * Stored form is self-describing so the cost parameters can be raised later
 * without invalidating existing hashes:
 *
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Cost parameters. N must be a power of two; 16384 keeps a hash around ~50ms
// on typical hardware, which is a good balance for an interactive login.
const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/** scrypt needs maxmem raised above the default for N=16384, r=8. */
const MAXMEM = 64 * 1024 * 1024;

/** Hash a plaintext password into its self-describing stored form. */
export function hashPassword(plain: string): string {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * Verify a plaintext password against a stored hash. Returns false (never
 * throws) for malformed/unknown hashes so a corrupt row can't 500 a login.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = scryptSync(plain, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    // Lengths match by construction here, but guard anyway — timingSafeEqual
    // throws on a length mismatch.
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
