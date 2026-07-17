/**
 * Typed configuration factory. All environment access funnels through here so
 * the rest of the app reads strongly-typed config from ConfigService rather
 * than poking at `process.env` directly.
 */

export interface AppConfig {
  server: {
    port: number;
    nodeEnv: string;
    logLevel: string;
    railwayEnvironment: string | null;
  };
  database: {
    url: string;
  };
  security: {
    internalApiKey: string;
  };
  auth: {
    adminUsername: string;
    adminPassword: string;
    sessionSecret: string;
    sessionTtlHours: number;
  };
  instantly: {
    apiKey: string;
    apiBase: string;
    timeoutMs: number;
    campaignIds: string[];
    eaccount: string | null;
  };
  stats: {
    apiUrl: string | null;
    botToken: string;
    timeoutMs: number;
  };
  claude: {
    apiKey: string;
    model: string;
    maxTokens: number;
    maxRetries: number;
  };
  jobs: {
    enableScheduler: boolean;
    cronOutreachSync: string;
    cronEmailSync: string;
    cronClaudeExtraction: string;
    cronStatsSync: string;
    upcomingDeadlineDays: number;
  };
}

/** Parse a comma-separated env var into a trimmed, non-empty string array. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export default (): AppConfig => ({
  server: {
    port: parseIntOr(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  security: {
    // Shared secret required on mutating requests via the x-api-key header.
    internalApiKey: process.env.INTERNAL_API_KEY ?? '',
  },
  auth: {
    // Admin-console credentials. When ADMIN_PASSWORD is unset, the read API and
    // UI stay open (dev/test); set it to enforce sign-in on the console + reads.
    adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.ADMIN_PASSWORD ?? '',
    // Secret used to sign session cookies. Falls back to INTERNAL_API_KEY, then
    // a per-boot random value (sessions won't survive a restart / span replicas).
    sessionSecret: process.env.AUTH_SESSION_SECRET ?? process.env.INTERNAL_API_KEY ?? '',
    sessionTtlHours: parseIntOr(process.env.AUTH_SESSION_TTL_HOURS, 12),
  },
  instantly: {
    apiKey: process.env.INSTANTLY_API_KEY ?? '',
    apiBase: (process.env.INSTANTLY_API_BASE ?? 'https://api.instantly.ai/api/v2').replace(
      /\/$/,
      '',
    ),
    timeoutMs: parseIntOr(process.env.INSTANTLY_TIMEOUT_MS, 15000),
    campaignIds: parseList(process.env.INSTANTLY_CAMPAIGN_IDS),
    eaccount: process.env.INSTANTLY_EACCOUNT || null,
  },
  stats: {
    // Base URL of the influence-stats (ReelMetrics) service. When unset, the
    // stats sync job is skipped entirely (nothing to poll).
    apiUrl: (process.env.STATS_API_URL || '').replace(/\/$/, '') || null,
    // Shared secret sent as `x-bot-token`; must equal influence-stats' BOT_TOKEN.
    botToken: process.env.STATS_BOT_TOKEN ?? '',
    timeoutMs: parseIntOr(process.env.STATS_TIMEOUT_MS, 20000),
  },
  claude: {
    apiKey: process.env.CLAUDE_API_KEY ?? '',
    model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-8',
    maxTokens: parseIntOr(process.env.CLAUDE_MAX_TOKENS, 1500),
    maxRetries: parseIntOr(process.env.CLAUDE_MAX_RETRIES, 3),
  },
  jobs: {
    enableScheduler: parseBool(process.env.ENABLE_SCHEDULER, true),
    cronOutreachSync: process.env.CRON_OUTREACH_SYNC ?? '*/30 * * * *',
    cronEmailSync: process.env.CRON_EMAIL_SYNC ?? '*/10 * * * *',
    cronClaudeExtraction: process.env.CRON_CLAUDE_EXTRACTION ?? '*/10 * * * *',
    cronStatsSync: process.env.CRON_STATS_SYNC ?? '*/30 * * * *',
    upcomingDeadlineDays: parseIntOr(process.env.UPCOMING_DEADLINE_DAYS, 30),
  },
});
