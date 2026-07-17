/**
 * Startup env validation. Runs before the app boots so misconfiguration fails
 * fast with a clear message instead of surfacing as a confusing runtime error.
 * DATABASE_URL is always required; the Instantly/Claude keys are required only
 * outside of the test environment (tests mock those integrations).
 */

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const nodeEnv = (config.NODE_ENV as string) ?? 'development';
  const isTest = nodeEnv === 'test';

  const errors: string[] = [];

  const required = (key: string) => {
    const value = config[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      errors.push(`Missing required environment variable: ${key}`);
    }
  };

  required('DATABASE_URL');

  if (!isTest) {
    required('INSTANTLY_API_KEY');
    required('CLAUDE_API_KEY');
  }

  const port = config.PORT;
  if (port !== undefined && Number.isNaN(Number(port))) {
    errors.push(`PORT must be a number, received: ${String(port)}`);
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  // Soft-required: INTERNAL_API_KEY protects the mutating endpoints via the
  // global ApiKeyGuard. If it's unset the guard still boots — writes just fall
  // back to unauthenticated with a loud runtime warning per request. We do NOT
  // crash the container here (that would block a Railway deploy on any service
  // that hasn't been given the env var yet); instead we surface a clear one-time
  // startup warning so operators can spot the missing config in logs.
  if (!isTest) {
    const key = config.INTERNAL_API_KEY;
    if (key === undefined || key === null || String(key).trim() === '') {
      // eslint-disable-next-line no-console
      console.warn(
        '[env] INTERNAL_API_KEY is not set — mutating endpoints (POST/PATCH/PUT/DELETE) will be UNAUTHENTICATED. Set INTERNAL_API_KEY in the environment to enforce x-api-key on writes.',
      );
    }

    const adminPass = config.ADMIN_PASSWORD;
    if (adminPass === undefined || adminPass === null || String(adminPass).trim() === '') {
      // eslint-disable-next-line no-console
      console.warn(
        '[env] ADMIN_PASSWORD is not set — the admin console sign-in and read endpoints (GET) will be UNAUTHENTICATED. Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME / AUTH_SESSION_SECRET) to require sign-in.',
      );
    }
  }

  return config;
}
