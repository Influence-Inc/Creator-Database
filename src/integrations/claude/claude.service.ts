import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EXTRACTION_SYSTEM_PROMPT, PromptMessage, buildThreadText } from './claude.prompts';
import { ClaudeDeliverables, ClaudeExtraction, ClaudeExtractionError } from './claude.types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps the Anthropic Messages API for structured extraction.
 *
 * Contract: given an email thread, return a `ClaudeExtraction`. The service
 * enforces the JSON-only contract defensively (strips accidental fences, finds
 * the JSON object, validates the shape) and retries transient API failures and
 * malformed responses before surfacing a `ClaudeExtractionError` for the caller
 * to dead-letter.
 */
@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: Anthropic;

  constructor(private readonly config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get<string>('claude.apiKey') ?? '',
    });
  }

  private get model(): string {
    return this.config.get<string>('claude.model') ?? 'claude-opus-4-8';
  }

  private get maxTokens(): number {
    return this.config.get<number>('claude.maxTokens') ?? 1500;
  }

  private get maxRetries(): number {
    return this.config.get<number>('claude.maxRetries') ?? 3;
  }

  /** Extract structured deal info from an ordered email thread. */
  async extractFromThread(messages: PromptMessage[]): Promise<ClaudeExtraction> {
    return this.extract(buildThreadText(messages));
  }

  /** Extract structured deal info from an arbitrary thread text. */
  async extract(threadText: string): Promise<ClaudeExtraction> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const started = Date.now();
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: threadText }],
        });

        const text = this.collectText(response);
        const extraction = this.parseExtraction(text);
        this.logger.debug('Claude extraction succeeded', {
          model: this.model,
          attempt,
          durationMs: Date.now() - started,
        });
        return extraction;
      } catch (err) {
        lastError = err;
        this.logger.warn(`Claude extraction attempt ${attempt} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < this.maxRetries) {
          await sleep(2 ** attempt * 500); // 1s, 2s, 4s...
        }
      }
    }

    throw new ClaudeExtractionError(
      `Claude extraction failed after ${this.maxRetries} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /** Concatenate all text blocks from a Messages API response. */
  private collectText(response: Anthropic.Message): string {
    return response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
  }

  /**
   * Parse the model output into a validated ClaudeExtraction, tolerating stray
   * code fences or leading/trailing prose by isolating the JSON object.
   */
  parseExtraction(text: string): ClaudeExtraction {
    const json = this.isolateJson(text);
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      throw new ClaudeExtractionError(
        `Claude returned non-JSON output: ${(err as Error).message}`,
        text,
      );
    }
    if (!raw || typeof raw !== 'object') {
      throw new ClaudeExtractionError('Claude returned a non-object payload', text);
    }
    return this.normalizeExtraction(raw as Record<string, unknown>);
  }

  private isolateJson(text: string): string {
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      throw new ClaudeExtractionError('No JSON object found in Claude output', text);
    }
    return t.slice(start, end + 1);
  }

  /** Coerce an arbitrary parsed object into the strict ClaudeExtraction shape. */
  private normalizeExtraction(raw: Record<string, unknown>): ClaudeExtraction {
    const strOrNull = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    const numOrStrOrNull = (v: unknown): string | number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
      return null;
    };
    const numOrNull = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return null;
    };

    const deliverablesRaw =
      raw.deliverables && typeof raw.deliverables === 'object'
        ? (raw.deliverables as Record<string, unknown>)
        : {};
    const deliverables: ClaudeDeliverables = {
      videos: numOrNull(deliverablesRaw.videos),
      stories: numOrNull(deliverablesRaw.stories),
      reels: numOrNull(deliverablesRaw.reels),
    };

    return {
      name: strOrNull(raw.name),
      instagram: strOrNull(raw.instagram),
      email: strOrNull(raw.email),
      deadline: strOrNull(raw.deadline),
      campaign: strOrNull(raw.campaign),
      accepted_rate: numOrStrOrNull(raw.accepted_rate),
      currency: strOrNull(raw.currency),
      guaranteed_views: numOrStrOrNull(raw.guaranteed_views),
      deliverables,
      notes: strOrNull(raw.notes),
      status: strOrNull(raw.status),
    };
  }
}
