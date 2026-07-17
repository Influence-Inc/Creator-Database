import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StatsCampaignsResponse } from './stats.types';

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Marks an error as safe to retry (transient 5xx / 429 / network / timeout). */
class RetryableError extends Error {
  readonly retryable = true;
}

/**
 * Thin, resilient client for the influence-stats (ReelMetrics) bot API.
 *
 * - Auth via the `x-bot-token` header (STATS_BOT_TOKEN must equal the stats
 *   service's BOT_TOKEN).
 * - Per-request timeout via AbortController.
 * - Retries transient failures (5xx, 429, network, timeout) with exponential
 *   backoff; fails fast on 4xx.
 *
 * `GET /api/bot/campaigns` returns the whole workspace in a single payload
 * (there is no pagination), so a single call fetches every campaign + creator.
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(private readonly config: ConfigService) {}

  /** True when STATS_API_URL is configured (otherwise the sync is skipped). */
  isConfigured(): boolean {
    return !!this.config.get<string | null>('stats.apiUrl');
  }

  private get base(): string {
    const url = this.config.get<string | null>('stats.apiUrl');
    if (!url) throw new Error('STATS_API_URL is not configured');
    return url;
  }

  private get botToken(): string {
    return this.config.get<string>('stats.botToken') ?? '';
  }

  private get timeoutMs(): number {
    return this.config.get<number>('stats.timeoutMs') ?? 20000;
  }

  private async request<T>(path: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.base}${path}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'x-bot-token': this.botToken },
          signal: controller.signal,
        });

        if (res.status >= 500 || res.status === 429) {
          const text = await res.text().catch(() => '');
          throw new RetryableError(`Stats GET ${path} -> ${res.status}: ${text}`);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Stats GET ${path} -> ${res.status}: ${text}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        const retryable =
          err instanceof RetryableError ||
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'TypeError'));
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        const backoff = 2 ** attempt * 1000;
        this.logger.warn(`Stats request failed (attempt ${attempt}); retrying in ${backoff}ms`, {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(backoff);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /** Fetch every campaign + creator snapshot from the stats service. */
  async fetchCampaigns(): Promise<StatsCampaignsResponse> {
    return this.request<StatsCampaignsResponse>('/api/bot/campaigns');
  }
}
