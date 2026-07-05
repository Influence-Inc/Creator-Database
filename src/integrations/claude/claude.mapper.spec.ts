import { NegotiationStatus } from '@prisma/client';
import { mapExtractionStatus, mapExtractionToCreator } from './claude.mapper';
import { ClaudeExtraction } from './claude.types';

function extraction(overrides: Partial<ClaudeExtraction> = {}): ClaudeExtraction {
  return {
    name: null,
    instagram: null,
    email: null,
    deadline: null,
    campaign: null,
    accepted_rate: null,
    currency: null,
    guaranteed_views: null,
    deliverables: { videos: null, stories: null, reels: null },
    notes: null,
    status: null,
    ...overrides,
  };
}

describe('claude.mapper', () => {
  describe('mapExtractionStatus', () => {
    it('maps known statuses case-insensitively', () => {
      expect(mapExtractionStatus('Accepted')).toBe(NegotiationStatus.ACCEPTED);
      expect(mapExtractionStatus('negotiating')).toBe(NegotiationStatus.NEGOTIATING);
      expect(mapExtractionStatus('declined')).toBe(NegotiationStatus.REJECTED);
      expect(mapExtractionStatus('done')).toBe(NegotiationStatus.COMPLETED);
    });
    it('returns undefined for unknown/empty', () => {
      expect(mapExtractionStatus('maybe')).toBeUndefined();
      expect(mapExtractionStatus(null)).toBeUndefined();
    });
  });

  describe('mapExtractionToCreator', () => {
    it('coerces "2 reels for 40k" into typed fields', () => {
      const input = mapExtractionToCreator(
        extraction({
          accepted_rate: '40k',
          deliverables: { videos: null, stories: null, reels: 2 },
          status: 'Accepted',
        }),
      );
      expect(input.acceptedRate).toBe(40000);
      expect(input.numberOfReels).toBe(2);
      expect(input.status).toBe(NegotiationStatus.ACCEPTED);
      // Unmentioned deliverables stay unset (not zeroed).
      expect(input.numberOfVideos).toBeUndefined();
    });

    it('normalizes identity + expands view shorthand', () => {
      const input = mapExtractionToCreator(
        extraction({
          name: '  Jane Doe ',
          instagram: '@JaneDoe',
          email: 'JANE@Example.com',
          guaranteed_views: '2M',
          deadline: '2026-07-18',
        }),
      );
      expect(input.creatorName).toBe('Jane Doe');
      expect(input.instagramUsername).toBe('janedoe');
      expect(input.email).toBe('jane@example.com');
      expect(input.guaranteedViews).toBe(2_000_000);
      expect(input.deadline instanceof Date).toBe(true);
    });

    it('attaches thread context and marks replied', () => {
      const when = new Date('2026-07-01T00:00:00Z');
      const input = mapExtractionToCreator(extraction({ name: 'X' }), {
        threadId: 'thread-1',
        lastReplyDate: when,
      });
      expect(input.threadId).toBe('thread-1');
      expect(input.lastReplyDate).toBe(when);
      expect(input.replied).toBe(true);
    });
  });
});
