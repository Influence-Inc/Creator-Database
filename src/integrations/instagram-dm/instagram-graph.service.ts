import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The slice of Meta's Graph API this integration needs: turning the
 * Instagram-scoped id Meta puts on a webhook into a username we can match
 * against a scout.
 *
 * Optional by design — with no access token configured, senders are matched
 * only by an id already cached on a scout, and anything else is filed as
 * unmatched for an admin to resolve. The integration degrades rather than
 * failing closed.
 */
@Injectable()
export class InstagramGraphService {
  private readonly logger = new Logger(InstagramGraphService.name);

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    return !!this.config.get<string>('instagramDm.accessToken');
  }

  /** Resolve an IGSID to its username, or null if that isn't possible. */
  async lookupUsername(igsid: string): Promise<string | null> {
    const token = this.config.get<string>('instagramDm.accessToken');
    if (!token) return null;

    const base = this.config.get<string>('instagramDm.graphBase') ?? 'https://graph.instagram.com';
    const url = new URL(`${base.replace(/\/$/, '')}/${encodeURIComponent(igsid)}`);
    url.searchParams.set('fields', 'username');
    url.searchParams.set('access_token', token);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        this.logger.warn(`Instagram profile lookup failed for ${igsid} (${res.status})`);
        return null;
      }
      const body = (await res.json()) as { username?: string };
      return typeof body.username === 'string' ? body.username.toLowerCase() : null;
    } catch (err) {
      this.logger.warn('Instagram profile lookup errored', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
