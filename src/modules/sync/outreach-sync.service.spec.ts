import { ConfigService } from '@nestjs/config';
import { ActivitySource } from '@prisma/client';
import { InstantlyService } from '../../integrations/instantly/instantly.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CreatorsService } from '../creators/creators.service';
import { DeadLetterService } from './dead-letter.service';
import { OutreachSyncService } from './outreach-sync.service';
import { SyncRunService } from './sync-run.service';

async function* gen<T>(items: T[]) {
  for (const item of items) yield item;
}

function setup(leadsByCampaign: Record<string, Record<string, unknown>[]>) {
  const campaigns = Object.keys(leadsByCampaign).map((id) => ({ id, name: `Campaign ${id}` }));
  const instantly = {
    iterateCampaigns: () => gen(campaigns),
    iterateLeads: (id: string) => gen(leadsByCampaign[id]),
  } as unknown as InstantlyService;
  const campaignsSvc = {
    upsert: jest.fn(({ name, instantlyCampaignId }) =>
      Promise.resolve({ id: `local-${instantlyCampaignId}`, name }),
    ),
  } as unknown as CampaignsService;
  const upsertFromSource = jest
    .fn()
    .mockResolvedValue({ creator: { id: 'x' }, created: false, changed: true, skipped: false });
  const creators = { upsertFromSource } as unknown as CreatorsService;
  const syncRun = {
    start: jest.fn().mockResolvedValue({ id: 'run' }),
    succeed: jest.fn((_run, counters) => Promise.resolve(counters)),
    fail: jest.fn((_run, counters) => Promise.resolve(counters)),
  } as unknown as SyncRunService;
  const config = { get: jest.fn().mockReturnValue([]) } as unknown as ConfigService;
  const deadLetter = { record: jest.fn() } as unknown as DeadLetterService;
  const svc = new OutreachSyncService(
    config,
    instantly,
    campaignsSvc,
    creators,
    deadLetter,
    syncRun,
  );
  return { svc, upsertFromSource };
}

describe('OutreachSyncService', () => {
  it('saves a creator who is a lead in several campaigns once per run', async () => {
    const { svc, upsertFromSource } = setup({
      a: [{ email: 'alice@x.co', timestamp_last_contact: '2026-01-01T00:00:00Z' }],
      b: [{ email: 'alice@x.co', timestamp_last_contact: '2026-03-01T00:00:00Z' }],
      c: [{ email: 'bob@x.co' }],
    });

    await svc.run();

    expect(upsertFromSource).toHaveBeenCalledTimes(2);
    const alice = upsertFromSource.mock.calls.find(([input]) => input.email === 'alice@x.co')!;
    // Most recently contacted campaign wins.
    expect(alice[0]).toMatchObject({ campaignId: 'local-b', campaignName: 'Campaign b' });
    expect(alice[1]).toBe(ActivitySource.INSTANTLY_DASHBOARD);
  });

  it('picks the same campaign whatever order the campaigns come back in', async () => {
    const leads = { a: [{ email: 'alice@x.co' }], b: [{ email: 'alice@x.co' }] };
    const first = setup(leads);
    const second = setup({ b: leads.b, a: leads.a });
    await first.svc.run();
    await second.svc.run();
    expect(first.upsertFromSource.mock.calls[0][0].campaignId).toBe(
      second.upsertFromSource.mock.calls[0][0].campaignId,
    );
  });
});
