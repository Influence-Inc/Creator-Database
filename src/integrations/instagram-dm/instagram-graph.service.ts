import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
export class InstagramGraphService implements OnModuleInit {
  private readonly logger = new Logger(InstagramGraphService.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // Scouts link their own Instagram by handle, and matching a handle to an
    // incoming message needs this token to turn Meta's opaque sender id into a
    // username. Without it, inbound DMs can never be placed automatically.
    if (this.config.get<string>('instagramDm.appSecret') && !this.configured) {
      this.logger.warn(
        'INSTAGRAM_ACCESS_TOKEN is not set — inbound Instagram DMs cannot be matched to a scout. Set it, or messages will pile up unmatched.',
      );
    }
  }

  get configured(): boolean {
    return !!this.config.get<string>('instagramDm.accessToken');
  }

  /** Result of a raw Graph call, keeping the error text for diagnosis. */
  private async get(
    path: string,
    params: Record<string, string>,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
    const token = this.config.get<string>('instagramDm.accessToken');
    if (!token) return { ok: false, error: 'INSTAGRAM_ACCESS_TOKEN is not set' };

    const base = this.config.get<string>('instagramDm.graphBase') ?? 'https://graph.instagram.com';
    const url = new URL(`${base.replace(/\/$/, '')}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (body?.error ?? {}) as { message?: string };
        return { ok: false, error: err.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, body };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The connected professional account's own id and username. */
  async me(): Promise<{ id: string; username: string } | null> {
    const res = await this.get('/me', { fields: 'id,username' });
    if (!res.ok) {
      this.logger.warn(`Could not read the connected Instagram account: ${res.error}`);
      return null;
    }
    const id = typeof res.body.id === 'string' ? res.body.id : null;
    const username = typeof res.body.username === 'string' ? res.body.username : '';
    return id ? { id, username } : null;
  }

  /**
   * Like `me()`, but keeps the failure reason instead of collapsing it to null.
   *
   * This is the single most diagnostic call in the whole integration: it says
   * which Instagram account the configured token actually belongs to. A token
   * for the wrong account subscribes the wrong inbox, so DMs sent to the company
   * account go nowhere — and from the outside that is indistinguishable from a
   * webhook that Meta simply never sends.
   */
  async whoami(): Promise<
    { ok: true; id: string; username: string } | { ok: false; error: string }
  > {
    const res = await this.get('/me', { fields: 'id,username' });
    if (!res.ok) return { ok: false, error: res.error };
    const id = typeof res.body.id === 'string' ? res.body.id : '';
    const username = typeof res.body.username === 'string' ? res.body.username : '';
    if (!id) return { ok: false, error: 'Graph returned no account id' };
    return { ok: true, id, username };
  }

  /**
   * Recent conversations with their messages, in one call via field expansion.
   *
   * This is the read-the-inbox route, used when webhook delivery can't be
   * relied on. Meta's exact field support varies, so the raw body is returned
   * rather than a parsed shape — the caller walks it defensively and the error
   * text is preserved for diagnosis.
   */
  async fetchConversations(limit = 25, messagesPerConversation = 25) {
    return this.get('/me/conversations', {
      platform: 'instagram',
      limit: String(limit),
      fields: `messages.limit(${messagesPerConversation}){id,created_time,from,to,message,attachments}`,
    });
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
