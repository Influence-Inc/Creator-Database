import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InstagramDmService } from './instagram-dm.service';
import { InstagramInboxScheduler } from './instagram-inbox.scheduler';

function make(settings: Record<string, unknown>, sync = jest.fn()) {
  const config = {
    get: jest.fn((key: string) => settings[key]),
  } as unknown as ConfigService;
  const registry = { addCronJob: jest.fn() } as unknown as SchedulerRegistry;
  const dm = { syncInbox: sync } as unknown as InstagramDmService;
  return { s: new InstagramInboxScheduler(config, registry, dm), registry, dm };
}

const ON = {
  'jobs.enableScheduler': true,
  'jobs.cronInstagramInbox': '*/2 * * * *',
  'instagramDm.accessToken': 'tok',
};

describe('InstagramInboxScheduler', () => {
  it('registers the poll when scheduling and a token are both in place', () => {
    const { s, registry } = make(ON);
    s.onModuleInit();
    expect(registry.addCronJob).toHaveBeenCalledWith('instagram-inbox', expect.anything());
    // Started for real, so stop it — a live cron timer would keep Jest alive.
    const [, job] = (registry.addCronJob as jest.Mock).mock.calls[0] as [string, { stop(): void }];
    job.stop();
  });

  it('does not register when scheduling is off', () => {
    const { s, registry } = make({ ...ON, 'jobs.enableScheduler': false });
    s.onModuleInit();
    expect(registry.addCronJob).not.toHaveBeenCalled();
  });

  it('does not register without a token, rather than failing every tick', () => {
    const { s, registry } = make({ ...ON, 'instagramDm.accessToken': '' });
    s.onModuleInit();
    // Nothing to poll with: a job that errors every two minutes is just noise.
    expect(registry.addCronJob).not.toHaveBeenCalled();
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
