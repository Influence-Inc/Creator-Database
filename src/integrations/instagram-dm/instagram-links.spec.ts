import {
  attachmentUrls,
  classifyLink,
  classifyMessageLinks,
  messageNode,
  permalinkFor,
  sharedItems,
  shortcodeFromMediaId,
} from './instagram-links';

// What Meta actually puts on a share: a temporary media URL, never a permalink.
const CDN =
  'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17912345678901234&signature=AbC';
const cdnFor = (assetId: string) =>
  `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=${assetId}&signature=AbC`;

// A published pair: this pk is the post at instagram.com/p/B8iwlG9pXHI.
const PK = '2243569220713804232';
const PK_CODE = 'B8iwlG9pXHI';

describe('shortcodeFromMediaId', () => {
  it('rebuilds the shortcode Instagram uses for a media pk', () => {
    expect(shortcodeFromMediaId(PK)).toBe(PK_CODE);
  });

  it('reads the "<pk>_<owner id>" form too', () => {
    expect(shortcodeFromMediaId(`${PK}_1234567`)).toBe(PK_CODE);
  });

  it('round-trips a current-day pk exactly', () => {
    const pk = '3712345678901234567';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const code = shortcodeFromMediaId(pk) ?? '';
    const back = [...code].reduce(
      (n, ch) => n * BigInt(64) + BigInt(alphabet.indexOf(ch)),
      BigInt(0),
    );
    expect(back.toString()).toBe(pk);
  });

  it('refuses ids that are not media pks rather than build a wrong link', () => {
    expect(shortcodeFromMediaId('17912345678901234')).toBeNull(); // Graph media id
    expect(shortcodeFromMediaId('1234567890123456')).toBeNull(); // Facebook video id
    expect(shortcodeFromMediaId('abc')).toBeNull();
    expect(shortcodeFromMediaId('')).toBeNull();
    expect(shortcodeFromMediaId(null)).toBeNull();
  });
});

describe('permalinkFor', () => {
  it('uses /reel/ for reels and /p/ for everything else', () => {
    expect(permalinkFor('ig_reel', PK, null)).toBe(`https://www.instagram.com/reel/${PK_CODE}`);
    expect(permalinkFor('ig_post', PK, null)).toBe(`https://www.instagram.com/p/${PK_CODE}`);
  });

  it("only reads asset_id off Meta's own media host", () => {
    expect(permalinkFor('ig_reel', null, `https://example.com/?asset_id=${PK}`)).toBeNull();
  });

  it('gives up cleanly when there is nothing to convert', () => {
    expect(permalinkFor('ig_reel', null, CDN)).toBeNull();
    expect(permalinkFor('ig_reel', null, null)).toBeNull();
  });
});

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

  it('reads Conversations API media and shares, which have no payload', () => {
    expect(
      attachmentUrls({
        attachments: {
          data: [{ video_data: { url: CDN } }, { image_data: { url: 'https://x.test/i.jpg' } }],
        },
        shares: { data: [{ link: 'https://www.instagram.com/p/BBB/' }] },
      }),
    ).toEqual([CDN, 'https://x.test/i.jpg', 'https://www.instagram.com/p/BBB/']);
  });
});

describe('sharedItems — webhook shares', () => {
  it('reads a shared reel as a reel even though its url is a CDN link', () => {
    // A 17-digit id is a Graph id, not a pk, so no permalink can be rebuilt
    // from it and the media link is kept.
    const [item] = sharedItems({
      attachments: [
        {
          type: 'ig_reel',
          payload: { reel_video_id: '17912345678901234', title: 'cooking hack', url: CDN },
        },
      ],
    });
    expect(item).toEqual({
      kind: 'reel',
      source: 'ig_reel',
      url: CDN,
      mediaUrl: CDN,
      mediaId: '17912345678901234',
      title: 'cooking hack',
      handle: null,
    });
  });

  it('turns a shared reel into its permanent instagram.com link', () => {
    const [item] = sharedItems({
      attachments: [{ type: 'ig_reel', payload: { reel_video_id: PK, url: CDN } }],
    });
    expect(item.kind).toBe('reel');
    expect(item.url).toBe(`https://www.instagram.com/reel/${PK_CODE}`);
    // The media link Meta sent is still kept alongside.
    expect(item.mediaUrl).toBe(CDN);
  });

  it('gives a shared post a /p/ link', () => {
    const [item] = sharedItems({
      attachments: [{ type: 'ig_post', payload: { id: PK, url: CDN } }],
    });
    expect(item.url).toBe(`https://www.instagram.com/p/${PK_CODE}`);
  });

  it("falls back to the media link's asset_id when the attachment names no id", () => {
    const [item] = sharedItems({
      attachments: [{ type: 'ig_reel', payload: { url: cdnFor(PK) } }],
    });
    expect(item.url).toBe(`https://www.instagram.com/reel/${PK_CODE}`);
  });

  it('keeps the media link rather than trust an id JSON already rounded', () => {
    // pks exceed 2^53, so one sent as a JSON number has lost its low digits.
    const payload = JSON.parse(`{"reel_video_id": ${PK}, "url": "${CDN}"}`);
    const [item] = sharedItems({ attachments: [{ type: 'ig_reel', payload }] });
    expect(item.url).toBe(CDN);
    expect(item.mediaId).toBeNull();
  });

  it('reads a shared post as a reel — it is still the content to remake', () => {
    const [item] = sharedItems({
      attachments: [{ type: 'ig_post', payload: { id: '3401234567890', url: CDN } }],
    });
    expect(item.kind).toBe('reel');
    expect(item.mediaId).toBe('3401234567890');
  });

  it('reads the legacy share type as a reel', () => {
    expect(sharedItems({ attachments: [{ type: 'share', payload: { url: CDN } }] })[0].kind).toBe(
      'reel',
    );
  });

  it('uses a real instagram.com link when a share carries one', () => {
    const out = sharedItems({
      attachments: [
        { type: 'share', payload: { url: 'https://www.instagram.com/mazeirons/' } },
        { type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/Da3JEdVow8N/?igsh=x' } },
      ],
    });
    expect(out.map((i) => [i.kind, i.url])).toEqual([
      ['profile', 'https://instagram.com/mazeirons'],
      ['reel', 'https://www.instagram.com/reel/Da3JEdVow8N'],
    ]);
  });

  it('reads a profile share by its handle', () => {
    for (const payload of [{ username: 'MazeIrons', url: CDN }, { title: '@mazeirons' }]) {
      const [item] = sharedItems({ attachments: [{ type: 'ig_profile', payload }] });
      expect(item.kind).toBe('profile');
      expect(item.url).toBe('https://instagram.com/mazeirons');
      expect(item.handle).toBe('mazeirons');
    }
  });

  it('does not invent a profile when a profile share has no handle', () => {
    const [item] = sharedItems({ attachments: [{ type: 'ig_profile', payload: { url: CDN } }] });
    expect(item.kind).toBe('unknown');
  });

  it('does not mistake a plain photo or video upload for a share', () => {
    const out = sharedItems({
      attachments: [
        { type: 'image', payload: { url: 'https://x.test/photo.jpg' } },
        { type: 'video', payload: { url: 'https://x.test/clip.mp4' } },
      ],
    });
    expect(out.map((i) => i.kind)).toEqual(['unknown', 'unknown']);
  });

  it('is unfazed by nothing at all', () => {
    expect(sharedItems(undefined)).toEqual([]);
    expect(sharedItems({})).toEqual([]);
  });
});

describe('sharedItems — Conversations API (inbox poll)', () => {
  it('reads a shared reel returned as video media', () => {
    const [item] = sharedItems({ attachments: { data: [{ id: 'a1', video_data: { url: CDN } }] } });
    expect(item.kind).toBe('reel');
    expect(item.url).toBe(CDN);
  });

  it('reads shared posts from the shares field', () => {
    const out = sharedItems({
      shares: {
        data: [{ link: CDN, name: 'caption' }, { link: 'https://www.instagram.com/p/BBB/' }],
      },
    });
    expect(out.map((i) => [i.kind, i.url])).toEqual([
      ['reel', CDN],
      ['reel', 'https://www.instagram.com/p/BBB'],
    ]);
  });
});

describe('classifyMessageLinks with shares', () => {
  it('files a CDN-linked share as a reel instead of dropping it', () => {
    const shares = sharedItems({ attachments: [{ type: 'ig_reel', payload: { url: CDN } }] });
    expect(classifyMessageLinks({ text: null, shares })).toEqual({
      profileLinks: [],
      reelLinks: [CDN],
      otherLinks: [],
    });
  });

  it('keeps an unrecognised attachment as other, not as a reel', () => {
    const shares = sharedItems({
      attachments: [{ type: 'audio', payload: { url: 'https://x.test/a.mp4' } }],
    });
    const out = classifyMessageLinks({ shares });
    expect(out.reelLinks).toEqual([]);
    expect(out.otherLinks).toEqual(['https://x.test/a.mp4']);
  });
});

describe('sharedItems — permanent links from the inbox poll', () => {
  it('rebuilds the link for video media from its asset_id', () => {
    const [item] = sharedItems({ attachments: { data: [{ video_data: { url: cdnFor(PK) } }] } });
    expect(item.url).toBe(`https://www.instagram.com/p/${PK_CODE}`);
  });

  it("never treats the attachment's own id as the media's", () => {
    const [item] = sharedItems({
      attachments: { data: [{ id: PK, video_data: { url: CDN } }] },
    });
    expect(item.url).toBe(CDN);
  });
});

describe('messageNode', () => {
  it('unwraps a stored webhook event to its message', () => {
    expect(messageNode({ sender: { id: '1' }, message: { mid: 'm', attachments: [] } })).toEqual({
      mid: 'm',
      attachments: [],
    });
  });

  it('returns an inbox-read message as-is, where `message` is just the text', () => {
    const item = { id: 'm', message: 'hello', attachments: { data: [] } };
    expect(messageNode(item)).toBe(item);
  });
});
