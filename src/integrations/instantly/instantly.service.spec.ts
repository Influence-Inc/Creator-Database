import { ConfigService } from '@nestjs/config';
import { InstantlyService } from './instantly.service';

function makeConfig(): ConfigService {
  const values: Record<string, unknown> = {
    'instantly.apiBase': 'https://api.instantly.test/v2',
    'instantly.apiKey': 'test-key',
    'instantly.timeoutMs': 5000,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('InstantlyService', () => {
  let service: InstantlyService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new InstantlyService(makeConfig());
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the bearer token and returns the parsed list body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: 'c1' }] }));

    const res = await service.listCampaigns();
    expect(res.items).toEqual([{ id: 'c1' }]);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toBe('Bearer test-key');
  });

  it('paginates leads across pages using the cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'a' }], next_starting_after: 'cur1' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'b' }], next_starting_after: null }));

    const ids: string[] = [];
    for await (const lead of service.iterateLeads('camp-1')) {
      ids.push(lead.id as string);
    }

    expect(ids).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on a 4xx without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad' }, 400));

    await expect(service.listCampaigns()).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
