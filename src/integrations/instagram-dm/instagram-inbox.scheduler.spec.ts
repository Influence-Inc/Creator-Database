import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InstagramDmService } from './instagram-dm.service';
import { InstagramInboxScheduler } from './instagram-inbox.scheduler';

function make(
  settings: Record<string, unknown>,
  sync = jest.fn(),
  refile = jest.fn().mockResolvedValue({ checked: 0, refiled: 0 }),
) {
  const config = {
    get: jest.fn((key: string) => settings[key]),
  } as unknown as ConfigService;
  const registry = {
    addInterval: jest.fn(),
    addTimeout: jest.fn(),
  } as unknown as SchedulerRegistry;
  const dm = { syncInbox: sync, refileDroppedShares: refile } as unknown as InstagramDmService;
  return { s: new InstagramInboxScheduler(config, registry, dm), registry, dm, refile };
}

/** Clear any timers a real (non-fake) onModuleInit started. */
function clearTimers(registry: SchedulerRegistry) {
  for (const [, h] of (registry.addInterval as jest.Mock).mock.calls) clearInterval(h);
  for (const [, h] of (registry.addTimeout as jest.Mock).mock.calls) clearTimeout(h);
}

const ON = {
  'jobs.enableScheduler': true,
  'jobs.instagramPollSeconds': 35,
  'instagramDm.accessToken': 'tok',
};

describe('InstagramInboxScheduler', () => {
  it('registers the poll when scheduling and a token are both in place', () => {
    const { s, registry } = make(ON);
    s.onModuleInit();
    expect(registry.addInterval).toHaveBeenCalledWith('instagram-inbox', expect.anything());
    // Started for real, so clear them — a live timer would keep Jest alive.
    clearTimers(registry);
  });

  it('re-files earlier dropped shares once, a minute after boot', async () => {
    jest.useFakeTimers();
    const { s, registry, refile } = make(ON);
    s.onModuleInit();
    expect(registry.addTimeout).toHaveBeenCalledWith('instagram-refile-shares', expect.anything());

    jest.advanceTimersByTime(59_999);
    expect(refile).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(refile).toHaveBeenCalledTimes(1);

    clearTimers(registry);
    jest.useRealTimers();
  });

  it('still re-files without a token, since that reads stored payloads not Graph', () => {
    const { s, registry } = make({ ...ON, 'instagramDm.accessToken': '' });
    s.onModuleInit();
    expect(registry.addTimeout).toHaveBeenCalledWith('instagram-refile-shares', expect.anything());
    expect(registry.addInterval).not.toHaveBeenCalled();
    clearTimers(registry);
  });

  it('does not let a failed re-file escape as an unhandled rejection', async () => {
    const refile = jest.fn().mockRejectedValue(new Error('db down'));
    const { s } = make(ON, jest.fn(), refile);
    const run = (
      s as unknown as { refileDroppedShares: () => Promise<void> }
    ).refileDroppedShares.bind(s);
    await expect(run()).resolves.toBeUndefined();
  });

  it('polls every 35 seconds', () => {
    jest.useFakeTimers();
    const sync = jest.fn().mockResolvedValue({ ok: true, filed: 0, unmatched: 0 });
    const { s, registry } = make(ON, sync);
    s.onModuleInit();

    jest.advanceTimersByTime(34_999);
    expect(sync).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(sync).toHaveBeenCalledTimes(1);

    clearTimers(registry);
    jest.useRealTimers();
  });

  it('does not register when scheduling is off', () => {
    const { s, registry } = make({ ...ON, 'jobs.enableScheduler': false });
    s.onModuleInit();
    expect(registry.addInterval).not.toHaveBeenCalled();
    expect(registry.addTimeout).not.toHaveBeenCalled();
  });

  it('does not register without a token, rather than failing every tick', () => {
    const { s, registry } = make({ ...ON, 'instagramDm.accessToken': '' });
    s.onModuleInit();
    // Nothing to poll with: a job that errors every two minutes is just noise.
    expect(registry.addInterval).not.toHaveBeenCalled();
    clearTimers(registry);
  });

  it('skips a tick while the previous poll is still running', async () => {
    const done = { ok: true, filed: 0, unmatched: 0 };
    let release!: () => void;
    // Only the first poll hangs; later ones resolve, so the test can't wedge
    // on its own fixture.
    const sync = jest
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(done))))
      .mockResolvedValue(done);
    const { s } = make(ON, sync);
    const tick = (s as unknown as { tick: () => Promise<void> }).tick.bind(s);

    const first = tick();
    await tick();
    // The second call must not start a concurrent read of the same inbox.
    expect(sync).toHaveBeenCalledTimes(1);

    release();
    await first;
    await tick();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('survives a poll that throws, so the schedule keeps running', async () => {
    const sync = jest.fn().mockRejectedValue(new Error('graph exploded'));
    const { s } = make(ON, sync);
    const tick = (s as unknown as { tick: () => Promise<void> }).tick.bind(s);

    await expect(tick()).resolves.toBeUndefined();
    // The guard must be released, or one failure would wedge polling forever.
    await tick();
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
