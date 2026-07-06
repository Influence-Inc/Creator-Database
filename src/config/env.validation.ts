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
    // Shared secret the Outreach backend sends as x-api-key on contract writes.
    required('INTERNAL_API_KEY');
  }

  const port = config.PORT;
  if (port !== undefined && Number.isNaN(Number(port))) {
    errors.push(`PORT must be a number, received: ${String(port)}`);
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return config;
}
