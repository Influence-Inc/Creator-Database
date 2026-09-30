import { ConfigService } from '@nestjs/config';
import { InstagramGraphService } from './instagram-graph.service';

/** Graph service with a token, and `fetch` answering from a queue of replies. */
function withReplies(replies: Array<{ status: number; body: unknown }>) {
  const config = {
    get: jest.fn((k: string) => (k === 'instagramDm.accessToken' ? 'tok' : undefined)),
  } as unknown as ConfigService;
  const calls: string[] = [];
  const fetchMock = jest.fn((url: string) => {
    calls.push(url);
    const next = replies.shift() ?? {
      status: 500,
      body: { error: { message: 'no reply queued' } },
    };
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: () => Promise.resolve(next.body),
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { graph: new InstagramGraphService(config), calls };
}

/** The `fields` the conversation read asked each message for. */
const fieldsOf = (url: string) => new URL(url).searchParams.get('fields') ?? '';

const FIELD_ERROR = {
  status: 400,
  body: {
    error: { message: '(#100) Tried accessing nonexisting field (shares) on node type (Message)' },
  },
};
const OK = { status: 200, body: { data: [] } };

describe('InstagramGraphService.fetchConversations', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('asks for shares and is_unsupported, which is where shared posts come back', async () => {
    const { graph, calls } = withReplies([OK]);
    const res = await graph.fetchConversations();
    expect(res.ok).toBe(true);
    expect(fieldsOf(calls[0])).toContain('attachments,shares,is_unsupported');
  });

  it('falls back to the core fields instead of breaking the poll when Meta rejects them', async () => {
    const { graph, calls } = withReplies([FIELD_ERROR, OK, OK]);

    expect((await graph.fetchConversations()).ok).toBe(true);
    expect(fieldsOf(calls[1])).not.toContain('shares');

    // Remembered: later polls go straight to the fields that work.
    await graph.fetchConversations();
    expect(calls).toHaveLength(3);
    expect(fieldsOf(calls[2])).not.toContain('shares');
  });

  it('keeps asking for shares after a failure that was not about the fields', async () => {
    const { graph, calls } = withReplies([
      { status: 500, body: { error: { message: 'Service temporarily unavailable' } } },
      OK,
      OK,
    ]);
    await graph.fetchConversations();
    await graph.fetchConversations();
    expect(fieldsOf(calls[2])).toContain('shares');
  });

  it('still reports the error when even the core read fails', async () => {
    const bad = { status: 400, body: { error: { message: 'Invalid OAuth access token' } } };
    const { graph } = withReplies([bad, bad]);
    const res = await graph.fetchConversations();
    expect(res).toEqual({ ok: false, error: 'Invalid OAuth access token' });
  });
});
