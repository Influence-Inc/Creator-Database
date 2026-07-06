import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InstantlyCampaign,
  InstantlyEmail,
  InstantlyLead,
  InstantlyListResponse,
} from './instantly.types';

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/** Marks an error as safe to retry (transient 5xx / 429 / network / timeout). */
class RetryableError extends Error {
  readonly retryable = true;
}

/**
 * Thin, resilient client for the Instantly v2 API.
 *
 * - Bearer auth from INSTANTLY_API_KEY.
 * - Per-request timeout via AbortController.
 * - Retries transient failures (5xx, 429, network, timeout) with exponential
 *   backoff; fails fast on 4xx.
 * - Cursor-based pagination helpers expose the whole workspace as async
 *   iterators so callers don't have to manage `starting_after` themselves.
 */
@Injectable()
export class InstantlyService {
  private readonly logger = new Logger(InstantlyService.name);

  constructor(private readonly config: ConfigService) {}

  private get base(): string {
    return this.config.get<string>('instantly.apiBase') ?? 'https://api.instantly.ai/api/v2';
  }

  private get apiKey(): string {
    const key = this.config.get<string>('instantly.apiKey');
    if (!key) throw new Error('INSTANTLY_API_KEY is not configured');
    return key;
  }

  private get timeoutMs(): number {
    return this.config.get<number>('instantly.timeoutMs') ?? 15000;
  }

  /** Perform a request with timeout + retry/backoff. */
  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url.toString(), {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: options.body != null ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        if (res.status >= 500 || res.status === 429) {
          const text = await res.text().catch(() => '');
          throw new RetryableError(`Instantly ${method} ${path} -> ${res.status}: ${text}`);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Instantly ${method} ${path} -> ${res.status}: ${text}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        const retryable =
          err instanceof RetryableError ||
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'TypeError'));
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        const backoff = 2 ** attempt * 1000;
        this.logger.warn(
          `Instantly request failed (attempt ${attempt}); retrying in ${backoff}ms`,
          {
            path,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        await sleep(backoff);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /** Extract the item array from a list envelope regardless of field name. */
  private items<T>(res: InstantlyListResponse<T>): T[] {
    return res.items ?? res.data ?? [];
  }

  private cursor<T>(res: InstantlyListResponse<T>): string | null {
    return res.next_starting_after ?? res.next_cursor ?? null;
  }

  // --- Campaigns -----------------------------------------------------------

  async listCampaigns(
    limit = 100,
    startingAfter?: string,
  ): Promise<InstantlyListResponse<InstantlyCampaign>> {
    return this.request('GET', '/campaigns', {
      query: { limit, starting_after: startingAfter },
    });
  }

  async *iterateCampaigns(): AsyncGenerator<InstantlyCampaign> {
    let cursor: string | undefined;
    do {
      const page = await this.listCampaigns(100, cursor);
      for (const campaign of this.items(page)) yield campaign;
      cursor = this.cursor(page) ?? undefined;
    } while (cursor);
  }

  // --- Leads (outreach dashboard rows) ------------------------------------

  async listLeads(params: {
    campaignId?: string;
    limit?: number;
    startingAfter?: string;
  }): Promise<InstantlyListResponse<InstantlyLead>> {
    return this.request('POST', '/leads/list', {
      body: {
        campaign_id: params.campaignId,
        limit: params.limit ?? 100,
        starting_after: params.startingAfter,
      },
    });
  }

  async *iterateLeads(campaignId?: string): AsyncGenerator<InstantlyLead> {
    let cursor: string | undefined;
    do {
      const page = await this.listLeads({ campaignId, limit: 100, startingAfter: cursor });
      for (const lead of this.items(page)) yield lead;
      cursor = this.cursor(page) ?? undefined;
    } while (cursor);
  }

  // --- Emails (threads) ----------------------------------------------------

  async listEmails(params: {
    limit?: number;
    startingAfter?: string;
    eaccount?: string | null;
  }): Promise<InstantlyListResponse<InstantlyEmail>> {
    return this.request('GET', '/emails', {
      query: {
        limit: params.limit ?? 100,
        starting_after: params.startingAfter,
        eaccount: params.eaccount ?? undefined,
      },
    });
  }

  /**
   * Iterate emails newest-first, capped at `maxPages` so a single sync run
   * doesn't walk the entire mailbox history. The scheduler runs frequently, so
   * recent pages are enough to keep the DB current.
   */
  async *iterateEmails(params: {
    eaccount?: string | null;
    maxPages?: number;
  }): AsyncGenerator<InstantlyEmail> {
    const maxPages = params.maxPages ?? 5;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await this.listEmails({
        limit: 100,
        startingAfter: cursor,
        eaccount: params.eaccount,
      });
      for (const email of this.items(page)) yield email;
      cursor = this.cursor(page) ?? undefined;
      pages += 1;
    } while (cursor && pages < maxPages);
  }
}
