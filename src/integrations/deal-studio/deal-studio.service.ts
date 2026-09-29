import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A campaign as Deal Studio lists it. */
export interface DealStudioCampaign {
  id: string;
  name: string;
  brandName: string;
}

export interface ScoutedCreatorInput {
  campaignId: string;
  instagramUsername: string;
  fullName?: string | null;
  scoutName?: string | null;
  reelLinks?: string[];
  /** Our scouting row id, stored on Deal Studio's side so either can find the other. */
  sourceRef?: string | null;
}

export interface ScoutedCreatorResult {
  /** False when the campaign already had this creator — still a success. */
  created: boolean;
  creatorId: number;
  status: string;
  campaign: DealStudioCampaign;
}

/**
 * A failed call, carrying the HTTP status when there was one. `status === 404`
 * on an add means the campaign no longer exists in Deal Studio, which needs an
 * admin to reassign the scout, not a retry.
 */
export class DealStudioError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'DealStudioError';
  }
}

/**
 * Client for the Outreach backend's bot API, which is where Deal Studio's
 * campaigns and creator lists live.
 *
 * - Auth via `x-bot-token` (DEAL_STUDIO_BOT_TOKEN must equal the Outreach
 *   backend's OUTREACH_BOT_TOKEN).
 * - Retries transient failures (5xx, 429, network, timeout). Safe for the add as
 *   well as the read: Deal Studio treats adding a creator the campaign already
 *   has as a success, so a retried write can never create a second row.
 */
@Injectable()
export class DealStudioService {
  private readonly logger = new Logger(DealStudioService.name);

  constructor(private readonly config: ConfigService) {}

  /** True when DEAL_STUDIO_URL is set. Without it, promote stays local. */
  isConfigured(): boolean {
    return !!this.config.get<string | null>('dealStudio.apiUrl');
  }

  private get base(): string {
    const url = this.config.get<string | null>('dealStudio.apiUrl');
    if (!url) throw new DealStudioError('DEAL_STUDIO_URL is not configured');
    return url;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    // Promote waits on this call, so writes give up sooner than reads.
    attempts = method === 'GET' ? 3 : 2,
  ): Promise<T> {
    const timeoutMs = this.config.get<number>('dealStudio.timeoutMs') ?? 15000;
    const token = this.config.get<string>('dealStudio.botToken') ?? '';
    let lastErr: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.base}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // Deal Studio answers with `{ error }`; surface that rather than raw JSON.
          let detail = text;
          try {
            detail = (JSON.parse(text) as { error?: string }).error ?? text;
          } catch {
            // Not JSON — keep the text.
          }
          throw new DealStudioError(
            `Deal Studio ${method} ${path} -> ${res.status}: ${detail}`,
            res.status,
            res.status >= 500 || res.status === 429,
          );
        }
        return (await res.json()) as T;
      } catch (err) {
        const retryable =
          (err instanceof DealStudioError && err.retryable) ||
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'TypeError'));
        lastErr =
          err instanceof DealStudioError
            ? err
            : new DealStudioError(
                err instanceof Error && err.name === 'AbortError'
                  ? `Deal Studio did not answer within ${timeoutMs / 1000}s`
                  : `Could not reach Deal Studio: ${err instanceof Error ? err.message : String(err)}`,
                null,
                retryable,
              );
        if (!retryable || attempt === attempts) throw lastErr;
        const backoff = 2 ** attempt * 1000;
        this.logger.warn(`Deal Studio ${method} ${path} failed (attempt ${attempt}); retrying`);
        await sleep(backoff);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  /** Every campaign a scout can be assigned to. */
  async listCampaigns(): Promise<DealStudioCampaign[]> {
    const res = await this.request<{ campaigns?: DealStudioCampaign[] }>(
      'GET',
      '/api/bot/campaigns',
    );
    return Array.isArray(res.campaigns) ? res.campaigns : [];
  }

  /** Add a promoted creator to a campaign. Idempotent on Deal Studio's side. */
  async addScoutedCreator(input: ScoutedCreatorInput): Promise<ScoutedCreatorResult> {
    return this.request<ScoutedCreatorResult>('POST', '/api/bot/scouted-creators', {
      campaign_id: input.campaignId,
      instagram_username: input.instagramUsername,
      full_name: input.fullName ?? undefined,
      scout_name: input.scoutName ?? undefined,
      reel_links: input.reelLinks ?? [],
      source_ref: input.sourceRef ?? undefined,
    });
  }
}
