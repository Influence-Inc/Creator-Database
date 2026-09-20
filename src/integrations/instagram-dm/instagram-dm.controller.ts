import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstagramMessageStatus, UserRole } from '@prisma/client';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SessionGuard } from '../../common/guards/session.guard';
import { InstagramDmService } from './instagram-dm.service';

/** Express request carrying the untouched body bytes (see main.ts). */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Meta's webhook for the company Instagram account, plus the admin-facing log.
 *
 *   GET  /integrations/instagram/webhook   Meta's subscription handshake
 *   POST /integrations/instagram/webhook   inbound direct messages
 *   GET  /integrations/instagram/messages  recent inbound messages (admin)
 *
 * The webhook routes are `@Public()` because Meta cannot present a session or
 * an API key. They are not unprotected: every POST must carry a valid
 * `X-Hub-Signature-256` computed with the app secret, and the GET handshake
 * must echo the configured verify token.
 */
@Controller('integrations/instagram')
export class InstagramDmController {
  private readonly logger = new Logger(InstagramDmController.name);

  constructor(
    private readonly dm: InstagramDmService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Subscription handshake. Meta calls this once with a challenge that has to
   * be echoed back verbatim as plain text.
   */
  @Public()
  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    const expected = this.config.get<string>('instagramDm.verifyToken');
    if (!expected) {
      this.logger.error('INSTAGRAM_VERIFY_TOKEN is not set — refusing the webhook handshake');
      throw new ForbiddenException('Instagram webhook is not configured');
    }
    if (mode !== 'subscribe' || token !== expected) {
      this.logger.warn('Rejected an Instagram webhook handshake with a bad verify token');
      throw new ForbiddenException('Verification failed');
    }
    res.type('text/plain').send(challenge ?? '');
  }

  /**
   * Inbound messages.
   *
   * Always answers 200 once the signature checks out: Meta retries anything
   * else, and a message we failed to file is already recorded with its error,
   * so a retry storm would add nothing. Processing happens inline but each
   * message is guarded by its own try/catch inside the service.
   */
  @Public()
  @Post('webhook')
  async receive(@Req() req: RawBodyRequest, @Body() body: unknown) {
    this.assertSignature(req);

    const messages = this.dm.extractMessages(body);
    if (messages.length === 0) return { received: true, messages: 0 };

    let applied = 0;
    for (const message of messages) {
      try {
        const outcome = await this.dm.ingest(message);
        if (outcome.status === InstagramMessageStatus.APPLIED) applied += 1;
      } catch (err) {
        // The service records its own failures; this is the last line so one
        // bad message can't drop the rest of the batch.
        this.logger.error('Unhandled error ingesting an Instagram message', {
          messageId: message.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { received: true, messages: messages.length, applied };
  }

  /** Recent inbound messages, including ones we couldn't place. */
  @Public()
  @UseGuards(SessionGuard)
  @Roles(UserRole.ADMIN)
  @Get('messages')
  recent(@Query('status') status?: string, @Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '', 10);
    const known = Object.values(InstagramMessageStatus) as string[];
    return this.dm.recent(
      Number.isFinite(parsed) ? parsed : 50,
      known.includes(status ?? '') ? (status as InstagramMessageStatus) : undefined,
    );
  }

  /** Link an unplaced sender to a scout and re-file what they already sent. */
  @Public()
  @UseGuards(SessionGuard)
  @Roles(UserRole.ADMIN)
  @Post('messages/:id/assign')
  assign(@Param('id') id: string, @Body() body: { scoutId?: string }) {
    if (!body?.scoutId) throw new BadRequestException('scoutId is required');
    return this.dm.assignSender(id, body.scoutId);
  }

  /**
   * Reject anything not signed with the app secret. Without a configured
   * secret the endpoint is closed entirely — an open webhook would let anyone
   * write rows onto a scout's sheet.
   */
  private assertSignature(req: RawBodyRequest): void {
    const secret = this.config.get<string>('instagramDm.appSecret');
    if (!secret) {
      this.logger.error('INSTAGRAM_APP_SECRET is not set — refusing webhook delivery');
      throw new ForbiddenException('Instagram webhook is not configured');
    }

    const header = req.headers['x-hub-signature-256'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || !provided.startsWith('sha256=')) {
      throw new ForbiddenException('Missing signature');
    }

    if (!req.rawBody) {
      // Without the exact bytes Meta signed, the digest can't be reproduced.
      throw new BadRequestException('Raw body unavailable for signature check');
    }

    const expected = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn('Rejected an Instagram webhook delivery with a bad signature');
      throw new ForbiddenException('Invalid signature');
    }
  }
}
