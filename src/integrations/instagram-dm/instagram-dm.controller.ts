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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SessionGuard } from '../../common/guards/session.guard';
import { InstagramDmService } from './instagram-dm.service';
import { parseSignedRequest } from './instagram-signed-request';

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
    this.logger.log('Instagram webhook handshake verified by Meta');
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
    // Log arrival before anything can reject it. Without this, "nothing in the
    // logs" is ambiguous — it could mean Meta never called, or that it called
    // and was turned away silently, which are completely different problems.
    this.logger.log('Instagram webhook delivery received');
    this.assertSignature(req);

    const messages = this.dm.extractMessages(body);
    if (messages.length === 0) {
      // Meta also sends read receipts, reactions and echoes here. Saying so
      // beats silence, which reads like the delivery never happened.
      this.logger.log('Instagram webhook delivery carried no usable messages');
      this.dm.recordDelivery(
        'no_usable_messages',
        'Meta called, but the payload held no incoming message — typically a read receipt, a reaction, or an echo of a message sent FROM the connected account',
      );
      return { received: true, messages: 0 };
    }

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
    this.logger.log(`Instagram webhook: ${messages.length} message(s) received, ${applied} filed`);
    return { received: true, messages: messages.length, applied };
  }

  /**
   * Is the Instagram integration configured, and has Meta ever delivered
   * anything? Admin-only; reports only whether each secret is present, never
   * the values.
   */
  @Public()
  @UseGuards(SessionGuard)
  @Roles(UserRole.ADMIN)
  @Get('status')
  status() {
    return this.dm.integrationStatus({
      appSecret: !!this.config.get<string>('instagramDm.appSecret'),
      verifyToken: !!this.config.get<string>('instagramDm.verifyToken'),
      accessToken: !!this.config.get<string>('instagramDm.accessToken'),
    });
  }

  /** How many links arrived from accounts not linked to any scout. */
  @Public()
  @UseGuards(SessionGuard)
  @Roles(UserRole.ADMIN)
  @Get('unmatched')
  unmatched() {
    return this.dm.unmatchedSummary();
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

  /**
   * Meta calls this when someone removes the app from their Instagram account.
   * The payload is a `signed_request`, not a header-signed body, so it's
   * verified with the app secret before anything is erased — otherwise anyone
   * could post a user id and wipe that person's records.
   */
  @Public()
  @Post('deauthorize')
  async deauthorize(@Body() body: { signed_request?: string }) {
    const payload = parseSignedRequest(
      body?.signed_request,
      this.config.get<string>('instagramDm.appSecret') ?? '',
    );
    if (!payload?.user_id) {
      this.logger.warn('Rejected an Instagram deauthorize callback with an invalid signed_request');
      throw new ForbiddenException('Invalid signed_request');
    }
    await this.dm.forgetSender(String(payload.user_id));
    return { success: true };
  }

  /**
   * Meta's data-deletion callback. Erases what we hold for that Instagram user
   * and answers in the shape Meta requires — a status URL plus a confirmation
   * code it can quote back to the person who asked.
   */
  @Public()
  @Post('data-deletion')
  async dataDeletion(@Body() body: { signed_request?: string }) {
    const payload = parseSignedRequest(
      body?.signed_request,
      this.config.get<string>('instagramDm.appSecret') ?? '',
    );
    if (!payload?.user_id) {
      this.logger.warn(
        'Rejected an Instagram data-deletion callback with an invalid signed_request',
      );
      throw new ForbiddenException('Invalid signed_request');
    }

    const userId = String(payload.user_id);
    await this.dm.forgetSender(userId);

    // Deletion happens inline, so the request is already complete by the time
    // this returns. The code is derived from the user id rather than stored, so
    // the status URL stays meaningful without keeping a record of the person
    // who just asked to be forgotten.
    const code = createHash('sha256').update(`ig-deletion:${userId}`).digest('hex').slice(0, 16);
    const base = (this.config.get<string>('instagramDm.publicBaseUrl') ?? '').replace(/\/$/, '');
    return {
      url: `${base}/integrations/instagram/data-deletion/${code}`,
      confirmation_code: code,
    };
  }

  /** Human-readable status page for a data-deletion confirmation code. */
  @Public()
  @Get('data-deletion/:code')
  deletionStatus(@Param('code') code: string, @Res() res: Response): void {
    res.type('text/html').send(
      '<!doctype html><meta charset="utf-8"><title>Data deletion</title>' +
        '<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.6">' +
        '<h1>Data deletion complete</h1>' +
        '<p>All Instagram data held for this request has been deleted.</p>' +
        `<p>Confirmation code: <code>${String(code)
          .replace(/[^a-f0-9]/gi, '')
          .slice(0, 64)}</code></p>` +
        '</body>',
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
      this.dm.recordDelivery('rejected_not_configured', 'INSTAGRAM_APP_SECRET is not set');
      throw new ForbiddenException('Instagram webhook is not configured');
    }

    const header = req.headers['x-hub-signature-256'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || !provided.startsWith('sha256=')) {
      this.logger.warn(
        'Rejected an Instagram webhook delivery with no X-Hub-Signature-256 header — the caller was not Meta',
      );
      this.dm.recordDelivery(
        'rejected_no_signature',
        'Something called the webhook without a signature header, so it was not Meta',
      );
      throw new ForbiddenException('Missing signature');
    }

    if (!req.rawBody) {
      // Without the exact bytes Meta signed, the digest can't be reproduced.
      this.logger.error(
        'Instagram webhook arrived but the raw body was unavailable, so the signature could not be checked',
      );
      this.dm.recordDelivery('rejected_no_raw_body', 'Raw request body was unavailable');
      throw new BadRequestException('Raw body unavailable for signature check');
    }

    const expected = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      // Overwhelmingly this is the wrong secret: Meta shows an *Instagram* app
      // secret and a *Facebook* app secret, and only the Instagram one signs
      // these deliveries.
      this.logger.warn(
        'Rejected an Instagram webhook delivery: signature did not match INSTAGRAM_APP_SECRET. Check you used the Instagram app secret, not the Facebook one.',
      );
      this.dm.recordDelivery(
        'rejected_bad_signature',
        'Signature did not match INSTAGRAM_APP_SECRET — check you used the Instagram app secret, not the Facebook one',
      );
      throw new ForbiddenException('Invalid signature');
    }
  }
}
