import { ConfigService } from '@nestjs/config';
import { DealStudioError, DealStudioService } from './deal-studio.service';

function service(settings: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'dealStudio.apiUrl': 'https://deals.example',
    'dealStudio.botToken': 'bot-secret',
    'dealStudio.timeoutMs': 1000,
    ...settings,
  };
  const config = { get: jest.fn((k: string) => values[k]) } as unknown as ConfigService;
  return new DealStudioService(config);
}

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('DealStudioService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  /** Run a call to completion, fast-forwarding any retry backoff. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    const settled = p.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await jest.runAllTimersAsync();
    const r = await settled;
    if (!r.ok) throw r.e;
    return r.v;
  }

  it('is not configured without a URL', () => {
    expect(service({ 'dealStudio.apiUrl': null }).isConfigured()).toBe(false);
    expect(service().isConfigured()).toBe(true);
  });

  it('authenticates with the bot token and sends the add in Deal Studio’s shape', async () => {
    fetchMock.mockResolvedValue(
      reply(201, { created: true, creatorId: 5, status: 'pending_extraction', campaign: {} }),
    );
    await settle(
      service().addScoutedCreator({
        campaignId: 'camp-1',
        instagramUsername: 'mery',
        scoutName: 'Alice',
        reelLinks: ['https://instagram.com/reel/a'],
        sourceRef: 'row-1',
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://deals.example/api/bot/scouted-creators');
    expect((init.headers as Record<string, string>)['x-bot-token']).toBe('bot-secret');
    expect(JSON.parse(init.body as string)).toEqual({
      campaign_id: 'camp-1',
      instagram_username: 'mery',
      scout_name: 'Alice',
      reel_links: ['https://instagram.com/reel/a'],
      source_ref: 'row-1',
    });
  });

  it('surfaces Deal Studio’s own error text and status, without retrying a 404', async () => {
    fetchMock.mockResolvedValue(reply(404, { error: 'No campaign with id gone' }));
    const err = await settle(
      service().addScoutedCreator({ campaignId: 'gone', instagramUsername: 'mery' }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DealStudioError);
    expect((err as DealStudioError).status).toBe(404);
    expect((err as DealStudioError).message).toMatch(/No campaign with id gone/);
    // A missing campaign won't reappear on its own; retrying only delays the answer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an outage and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(503, 'down'))
      .mockResolvedValueOnce(reply(200, { campaigns: [{ id: 'c', name: 'N', brandName: 'B' }] }));
    const campaigns = await settle(service().listCampaigns());
    expect(campaigns).toEqual([{ id: 'c', name: 'N', brandName: 'B' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a write sooner than on a read, since promote waits on it', async () => {
    fetchMock.mockResolvedValue(reply(503, 'down'));
    await settle(service().addScoutedCreator({ campaignId: 'c', instagramUsername: 'm' })).catch(
      () => undefined,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    await settle(service().listCampaigns()).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('describes a network failure in plain words', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed')));
    const err = await settle(service().listCampaigns()).catch((e: unknown) => e);
    expect((err as Error).message).toBe('Could not reach Deal Studio: fetch failed');
  });
});
