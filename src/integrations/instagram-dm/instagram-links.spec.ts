import { attachmentUrls, classifyLink, classifyMessageLinks } from './instagram-links';

describe('classifyLink', () => {
  it('reads a bare handle as a profile and canonicalises it', () => {
    for (const raw of [
      'https://instagram.com/mazeirons',
      'https://www.instagram.com/mazeirons/',
      'http://instagram.com/MazeIrons',
      'https://instagram.com/mazeirons?igsh=abc123',
    ]) {
      const out = classifyLink(raw);
      expect(out.kind).toBe('profile');
      expect(out.url).toBe('https://instagram.com/mazeirons');
      expect(out.handle).toBe('mazeirons');
    }
  });

  it('reads reel, post and tv links as reels', () => {
    expect(classifyLink('https://www.instagram.com/reel/Da3JEdVow8N/').kind).toBe('reel');
    expect(classifyLink('https://instagram.com/reels/Da3JEdVow8N').kind).toBe('reel');
    expect(classifyLink('https://instagram.com/p/ABC123/').kind).toBe('reel');
    expect(classifyLink('https://instagram.com/tv/ABC123/').kind).toBe('reel');
  });

  it('treats /<handle>/reel/<id> as the reel, not the person', () => {
    const out = classifyLink('https://www.instagram.com/mazeirons/reel/Da3JEdVow8N/');
    expect(out.kind).toBe('reel');
    expect(out.url).toBe('https://www.instagram.com/mazeirons/reel/Da3JEdVow8N');
  });

  it('strips tracking query strings from reel links', () => {
    expect(classifyLink('https://www.instagram.com/reel/XYZ/?igsh=zzz&utm_source=ig').url).toBe(
      'https://www.instagram.com/reel/XYZ',
    );
  });

  it("never mistakes Instagram's own pages for a creator profile", () => {
    for (const raw of [
      'https://instagram.com/explore/tags/food',
      'https://instagram.com/accounts/login',
      'https://instagram.com/direct/inbox',
    ]) {
      expect(classifyLink(raw).kind).not.toBe('profile');
    }
  });

  it('classifies non-Instagram and CDN urls as other', () => {
    expect(classifyLink('https://example.com/hello').kind).toBe('other');
    expect(classifyLink('https://scontent.cdninstagram.com/v/t50/12345_n.mp4?oe=1').kind).toBe(
      'other',
    );
    expect(classifyLink('not a url').kind).toBe('other');
  });
});

describe('classifyMessageLinks', () => {
  it('pulls links out of free text alongside other words', () => {
    const out = classifyMessageLinks({
      text: 'found this guy https://instagram.com/mazeirons and his reel https://instagram.com/reel/AAA/ — worth a look?',
    });
    expect(out.profileLinks).toEqual(['https://instagram.com/mazeirons']);
    expect(out.reelLinks).toEqual(['https://instagram.com/reel/AAA']);
    expect(out.otherLinks).toEqual([]);
  });

  it('strips trailing punctuation from a pasted link', () => {
    const out = classifyMessageLinks({ text: 'check https://instagram.com/mazeirons.' });
    expect(out.profileLinks).toEqual(['https://instagram.com/mazeirons']);
  });

  it('de-duplicates the same link sent twice', () => {
    const out = classifyMessageLinks({
      text: 'https://instagram.com/mazeirons https://www.instagram.com/mazeirons/',
    });
    expect(out.profileLinks).toHaveLength(1);
  });

  it('reads share attachments as well as text', () => {
    const out = classifyMessageLinks({
      text: null,
      attachmentUrls: ['https://www.instagram.com/reel/Da3JEdVow8N/'],
    });
    expect(out.reelLinks).toEqual(['https://www.instagram.com/reel/Da3JEdVow8N']);
  });

  it('keeps an unrecognised share url instead of dropping it', () => {
    // Meta sometimes sends a CDN media url for a reel share rather than the
    // permalink. It still needs to survive so an admin can see what arrived.
    const out = classifyMessageLinks({
      attachmentUrls: ['https://lookaside.fbsbx.com/ig_messaging/abc.mp4'],
    });
    expect(out.reelLinks).toEqual([]);
    expect(out.otherLinks).toEqual(['https://lookaside.fbsbx.com/ig_messaging/abc.mp4']);
  });

  it('returns nothing for a message with no links', () => {
    const out = classifyMessageLinks({ text: 'hey, sending some finds over now' });
    expect(out).toEqual({ profileLinks: [], reelLinks: [], otherLinks: [] });
  });
});

describe('attachmentUrls', () => {
  it('reads the array form Meta sends on a webhook', () => {
    expect(
      attachmentUrls({
        attachments: [
          { type: 'ig_reel', payload: { url: 'https://instagram.com/reel/AAA/' } },
          { type: 'share', payload: { url: 'https://instagram.com/mazeirons' } },
        ],
      }),
    ).toEqual(['https://instagram.com/reel/AAA/', 'https://instagram.com/mazeirons']);
  });

  it('reads the {data:[…]} form the Conversations API returns', () => {
    expect(
      attachmentUrls({
        attachments: { data: [{ payload: { url: 'https://instagram.com/p/BBB/' } }] },
      }),
    ).toEqual(['https://instagram.com/p/BBB/']);
  });

  it('is unfazed by a message with no attachments', () => {
    expect(attachmentUrls({})).toEqual([]);
    expect(attachmentUrls({ attachments: null as never })).toEqual([]);
  });
});
