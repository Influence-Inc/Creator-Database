import { BadRequestException } from '@nestjs/common';
import { ActivitySource, NegotiationStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatorsService } from '../creators/creators.service';
import { ContractsService } from './contracts.service';

describe('ContractsService.createFromOutreach', () => {
  let service: ContractsService;
  let prisma: { contract: { findUnique: jest.Mock; upsert: jest.Mock } };
  let creators: { upsertFromSource: jest.Mock };

  beforeEach(() => {
    prisma = { contract: { findUnique: jest.fn(), upsert: jest.fn() } };
    creators = { upsertFromSource: jest.fn() };
    service = new ContractsService(
      prisma as unknown as PrismaService,
      creators as unknown as CreatorsService,
    );
  });

  it('rejects a payload with no creator identity', async () => {
    await expect(service.createFromOutreach({ contractRef: 'tok' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(creators.upsertFromSource).not.toHaveBeenCalled();
  });

  it('upserts the creator by identity with the final terms, then creates the contract', async () => {
    creators.upsertFromSource.mockResolvedValue({
      creator: { id: 'c1' }, created: true, changed: true, skipped: false,
    });
    prisma.contract.findUnique.mockResolvedValue(null);
    prisma.contract.upsert.mockResolvedValue({ id: 'k1' });

    const res = await service.createFromOutreach({
      email: 'alex@example.com',
      instagramUsername: 'alex',
      contractRef: 'tok-123',
      compensation: 900,
      currency: 'USD',
      numberOfDeliverables: 2,
      guaranteedViews: 100000,
      deadline: '2026-07-30T00:00:00.000Z',
      deliverables: '2 short-form videos',
      campaignName: 'Spring',
    });

    // Creator upsert maps commercial fields + flips the deal to COMPLETED.
    expect(creators.upsertFromSource).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'alex@example.com',
        instagramUsername: 'alex',
        acceptedRate: 900,
        numberOfVideos: 2,
        guaranteedViews: 100000,
        status: NegotiationStatus.COMPLETED,
      }),
      ActivitySource.CONTRACT_SIGNED,
    );
    // Contract linked to the resolved creator.
    const upsertArg = prisma.contract.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ contractRef: 'tok-123' });
    expect(upsertArg.create.creatorId).toBe('c1');
    expect(upsertArg.create.compensation).toBe(900);
    expect(res).toEqual({ creatorId: 'c1', contractId: 'k1', created: true });
  });

  it('is idempotent on contractRef — a re-sync updates, not duplicates', async () => {
    creators.upsertFromSource.mockResolvedValue({
      creator: { id: 'c1' }, created: false, changed: true, skipped: false,
    });
    prisma.contract.findUnique.mockResolvedValue({ id: 'k1' }); // already exists
    prisma.contract.upsert.mockResolvedValue({ id: 'k1' });

    const res = await service.createFromOutreach({ email: 'a@b.com', contractRef: 'tok-123' });
    expect(res.created).toBe(false);
    expect(prisma.contract.upsert).toHaveBeenCalledTimes(1);
  });

  it('throws when the creator cannot be resolved', async () => {
    creators.upsertFromSource.mockResolvedValue({
      creator: null, created: false, changed: false, skipped: true,
    });
    await expect(
      service.createFromOutreach({ email: 'a@b.com', contractRef: 'tok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
