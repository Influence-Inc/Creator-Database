import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * True when running on Railway or with NODE_ENV=production. A deployed instance
 * never falls back to "auth off": a missing or mid-rotation secret must lock
 * the API, not publish it.
 */
export function isDeployed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID) ||
    env.NODE_ENV === 'production'
  );
}

/**
 * Constant-time comparison of a presented secret against the expected one.
 * Hashing first makes both sides the same length, so neither the comparison
 * nor a length mismatch leaks anything about the secret.
 */
export function secretEquals(presented: unknown, expected: string | undefined | null): boolean {
  if (typeof presented !== 'string' || !presented || !expected) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The x-api-key header as a single string (Express may hand back an array). */
export function apiKeyHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const provided = headers['x-api-key'];
  return Array.isArray(provided) ? provided[0] : provided;
}
