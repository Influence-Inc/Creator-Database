import { mapEmail, mapLeadToCreator } from './instantly.mapper';

describe('instantly.mapper', () => {
  describe('mapLeadToCreator', () => {
    it('reads custom variables from the lead payload', () => {
      const input = mapLeadToCreator(
        {
          email: 'Creator@Example.com',
          first_name: 'Jane',
          last_name: 'Doe',
          status: 1,
          payload: {
            instagram: '@janedoe',
            average_views: '250k',
            cpm: '15',
            accepted_rate: '40k',
            currency: 'usd',
            manager: 'Jennifer',
          },
        },
        { campaignId: 'local-1', campaignName: 'Summer Launch' },
      );

      expect(input.email).toBe('creator@example.com');
      expect(input.instagramUsername).toBe('janedoe');
      expect(input.creatorName).toBe('Jane Doe');
      expect(input.averageViews).toBe(250_000);
      expect(input.cpm).toBe(15);
      expect(input.acceptedRate).toBe(40_000);
      expect(input.currency).toBe('USD');
      expect(input.assignedManager).toBe('Jennifer');
      expect(input.campaignId).toBe('local-1');
      expect(input.campaignName).toBe('Summer Launch');
      expect(input.outreachStage).toBe('Active');
    });

    it('falls back to first/last name and omits unknown fields', () => {
      const input = mapLeadToCreator({ first_name: 'Solo', last_name: 'Creator' });
      expect(input.creatorName).toBe('Solo Creator');
      expect(input.email).toBeUndefined();
      expect(input.cpm).toBeUndefined();
    });
  });

  describe('mapEmail', () => {
    it('maps core fields and prefers the text body', () => {
      const mapped = mapEmail({
        id: 'msg-1',
        thread_id: 'thread-1',
        from_address_email: 'creator@example.com',
        to_address_email_list: 'jennifer@useinfluence.xyz',
        subject: 'Re: Collab',
        timestamp_email: '2026-07-01T12:00:00Z',
        body: { text: 'We can do 2 reels for 40k', html: '<p>ignored</p>' },
      });

      expect(mapped).not.toBeNull();
      expect(mapped?.messageId).toBe('msg-1');
      expect(mapped?.threadId).toBe('thread-1');
      expect(mapped?.sender).toBe('creator@example.com');
      expect(mapped?.rawEmail).toContain('2 reels for 40k');
      expect(mapped?.timestamp instanceof Date).toBe(true);
    });

    it('falls back to message id as thread id when absent', () => {
      const mapped = mapEmail({ message_id: 'only-msg', body: 'hi' });
      expect(mapped?.threadId).toBe('only-msg');
      expect(mapped?.rawEmail).toBe('hi');
    });

    it('returns null when there is no message id', () => {
      expect(mapEmail({ subject: 'orphan' })).toBeNull();
    });
  });
});
