import { ConfigService } from '@nestjs/config';
import { ClaudeService } from './claude.service';
import { ClaudeExtractionError } from './claude.types';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'claude.apiKey': 'test-key',
    'claude.model': 'claude-opus-4-8',
    'claude.maxTokens': 1500,
    'claude.maxRetries': 1,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Fake Anthropic client whose messages.create is controllable per test. */
function stubClient(service: ClaudeService, create: jest.Mock) {
  (service as unknown as { client: { messages: { create: jest.Mock } } }).client = {
    messages: { create },
  };
}

const VALID_JSON = JSON.stringify({
  name: 'Jane Doe',
  instagram: 'janedoe',
  email: 'jane@example.com',
  deadline: '2026-07-18',
  campaign: 'Summer Launch',
  accepted_rate: 40000,
  currency: 'USD',
  guaranteed_views: 2000000,
  deliverables: { videos: 0, stories: 0, reels: 2 },
  notes: 'Confirmed 2 reels',
  status: 'Accepted',
});

describe('ClaudeService', () => {
  describe('parseExtraction', () => {
    it('parses a clean JSON object', () => {
      const service = new ClaudeService(makeConfig());
      const result = service.parseExtraction(VALID_JSON);
      expect(result.name).toBe('Jane Doe');
      expect(result.accepted_rate).toBe(40000);
      expect(result.deliverables.reels).toBe(2);
      expect(result.status).toBe('Accepted');
    });

    it('tolerates markdown code fences', () => {
      const service = new ClaudeService(makeConfig());
      const result = service.parseExtraction('```json\n' + VALID_JSON + '\n```');
      expect(result.email).toBe('jane@example.com');
    });

    it('tolerates surrounding prose by isolating the JSON object', () => {
      const service = new ClaudeService(makeConfig());
      const result = service.parseExtraction(`Here you go:\n${VALID_JSON}\nHope that helps!`);
      expect(result.campaign).toBe('Summer Launch');
    });

    it('defaults missing fields to null and coerces deliverables', () => {
      const service = new ClaudeService(makeConfig());
      const result = service.parseExtraction('{"name":"Bob"}');
      expect(result.name).toBe('Bob');
      expect(result.email).toBeNull();
      expect(result.deliverables).toEqual({ videos: null, stories: null, reels: null });
    });

    it('throws when no JSON object is present', () => {
      const service = new ClaudeService(makeConfig());
      expect(() => service.parseExtraction('no json here')).toThrow(ClaudeExtractionError);
    });
  });

  describe('extract', () => {
    it('returns the parsed extraction from the model response', async () => {
      const service = new ClaudeService(makeConfig());
      const create = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: VALID_JSON }],
      });
      stubClient(service, create);

      const result = await service.extract('some thread text');
      expect(create).toHaveBeenCalledTimes(1);
      expect(result.instagram).toBe('janedoe');
      expect(result.guaranteed_views).toBe(2000000);
    });

    it('throws ClaudeExtractionError after exhausting retries', async () => {
      const service = new ClaudeService(makeConfig({ 'claude.maxRetries': 1 }));
      const create = jest.fn().mockRejectedValue(new Error('API down'));
      stubClient(service, create);

      await expect(service.extract('thread')).rejects.toBeInstanceOf(ClaudeExtractionError);
      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
