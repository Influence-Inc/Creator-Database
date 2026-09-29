import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { QualificationStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthPrincipal } from '../auth/auth.service';
import {
  DealStudioError,
  DealStudioService,
} from '../../integrations/deal-studio/deal-studio.service';
import { CreatorsService } from '../creators/creators.service';
import { reelLinksIn, ScoutsService } from './scouts.service';

const ALICE: AuthPrincipal = { username: 'scout.alice', uid: 'alice-id', role: UserRole.SCOUT };
const ADMIN: AuthPrincipal = { username: 'admin', uid: null, role: UserRole.ADMIN };

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    scoutEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      ...(overrides.scoutEntry as object),
    },
    creator: {
      findUnique: jest.fn().mockResolvedValue(null),
      ...(overrides.creator as object),
    },
  } as unknown as PrismaService;
}

const noCreators = { upsertFromSource: jest.fn() } as unknown as CreatorsService;
/** Deal Studio not connected: promote stays local, as it did before the link. */
const noDealStudio = { isConfigured: () => false } as unknown as DealStudioService;

describe('ScoutsService', () => {
  describe('ownership scoping', () => {
    it('always narrows a scout to their own rows, ignoring a requested scoutId', async () => {
      const prisma = makePrisma();
      const service = new ScoutsService(prisma, noCreators, noDealStudio);

      await service.list(ALICE, { scoutId: 'someone-else-id' });

      const where = (prisma.scoutEntry.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.scoutId).toBe('alice-id');
    });

    it('lets an admin filter by scout, or see everything', async () => {
      const prisma = makePrisma();
      const service = new ScoutsService(prisma, noCreators, noDealStudio);

      await service.list(ADMIN, { scoutId: 'bob-id' });
      expect((prisma.scoutEntry.findMany as jest.Mock).mock.calls[0][0].where.scoutId).toBe(
        'bob-id',
      );

      await service.list(ADMIN, {});
      expect(
        (prisma.scoutEntry.findMany as jest.Mock).mock.calls[1][0].where.scoutId,
      ).toBeUndefined();
    });

    it("hides another scout's row behind a 404 rather than a 403", async () => {
      const prisma = makePrisma({
        scoutEntry: { findUnique: jest.fn().mockResolvedValue({ id: 'r1', scoutId: 'bob-id' }) },
      });
      const service = new ScoutsService(prisma, noCreators, noDealStudio);

      // 404 (not 403) so a scout can't probe for the existence of others' rows.
      await expect(service.update('r1', ALICE, { country: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.remove('r1', ALICE)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('admin-only fields', () => {
    it('never lets a scout edit qualification or notes', async () => {
      const entry = { id: 'r1', scoutId: 'alice-id', instagramUsername: 'x' };
      const prisma = makePrisma({
        scoutEntry: {
          findUnique: jest.fn().mockResolvedValue(entry),
          update: jest.fn().mockResolvedValue(entry),
        },
      });
      const service = new ScoutsService(prisma, noCreators, noDealStudio);

      // Even if the fields are smuggled past the DTO, the service ignores them.
      await service.update('r1', ALICE, {
        country: 'India',
        qualification: QualificationStatus.QUALIFIED,
        notes: 'self approved',
      } as never);

      const data = (prisma.scoutEntry.update as jest.Mock).mock.calls[0][0].data;
      expect(data.country).toBe('India');
      expect(data).not.toHaveProperty('qualification');
      expect(data).not.toHaveProperty('notes');
    });

    it('refuses review and promote for a scout', async () => {
      const service = new ScoutsService(makePrisma(), noCreators, noDealStudio);
      await expect(
        service.review('r1', ALICE, { qualification: QualificationStatus.QUALIFIED }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.promote('r1', ALICE)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('promotion', () => {
    it('refuses to promote a row that has not been qualified', async () => {
      const prisma = makePrisma({
        scoutEntry: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'r1',
            qualification: QualificationStatus.PENDING,
            instagramUsername: 'someone',
            scout: { username: 'scout.alice', displayName: 'Alice' },
          }),
        },
      });
      const service = new ScoutsService(prisma, noCreators, noDealStudio);
      await expect(service.promote('r1', ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('merges a qualified row into the Creator DB and links it back', async () => {
      const entry = {
        id: 'r1',
        rowNumber: 3,
        qualification: QualificationStatus.QUALIFIED,
        instagramUsername: 'found.creator',
        instagramProfileLink: 'https://instagram.com/found.creator',
        scout: { username: 'scout.alice', displayName: 'Alice' },
      };
      const prisma = makePrisma({
        scoutEntry: {
          findUnique: jest.fn().mockResolvedValue(entry),
          findUniqueOrThrow: jest.fn().mockResolvedValue(entry),
          update: jest.fn().mockResolvedValue({ ...entry, promotedCreatorId: 'creator-1' }),
        },
      });
      const creators = {
        upsertFromSource: jest
          .fn()
          .mockResolvedValue({ creator: { id: 'creator-1' }, created: true }),
      } as unknown as CreatorsService;

      const service = new ScoutsService(prisma, creators, noDealStudio);
      const result = await service.promote('r1', ADMIN);

      // Routed through the shared merge path so a known creator is updated,
      // not duplicated.
      const [input, source] = (creators.upsertFromSource as jest.Mock).mock.calls[0];
      expect(input.instagramUsername).toBe('found.creator');
      expect(input.assignedManager).toBe('Alice');
      expect(source).toBe('SCOUT_PROMOTION');
      expect(result.creatorId).toBe('creator-1');
      expect((prisma.scoutEntry.update as jest.Mock).mock.calls[0][0].data.promotedCreatorId).toBe(
        'creator-1',
      );
    });
  });

  describe('Deal Studio', () => {
    /**
     * A qualified row whose updates are applied to a live object, so each test
     * can assert on what actually ended up stored rather than on call shapes.
     */
    function setup(
      opts: {
        campaignId?: string | null;
        configured?: boolean;
        add?: jest.Mock;
        stored?: Record<string, unknown>;
      } = {},
    ) {
      const row: Record<string, unknown> = {
        id: 'r1',
        rowNumber: 3,
        qualification: QualificationStatus.QUALIFIED,
        instagramUsername: 'found.creator',
        instagramProfileLink: 'https://instagram.com/found.creator',
        reelIdeas:
          'this one https://www.instagram.com/reel/AbC. and again https://www.instagram.com/reel/AbC',
        promotedCreatorId: null,
        dealStudioAddedAt: null,
        ...opts.stored,
        scout: {
          username: 'scout.alice',
          displayName: 'Alice',
          dealStudioCampaignId: opts.campaignId === undefined ? 'camp-1' : opts.campaignId,
          dealStudioCampaignName: 'Acme — Summer',
        },
        promotedCreator: { creatorName: 'Found Creator' },
      };
      const prisma = makePrisma({
        scoutEntry: {
          findUnique: jest.fn(async () => row),
          findUniqueOrThrow: jest.fn(async () => row),
          update: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
            Object.assign(row, data),
          ),
        },
      });
      const creators = {
        upsertFromSource: jest.fn().mockResolvedValue({
          creator: { id: 'creator-1', creatorName: 'Found Creator' },
          created: true,
        }),
      } as unknown as CreatorsService;
      const add =
        opts.add ??
        jest.fn().mockResolvedValue({
          created: true,
          creatorId: 77,
          status: 'pending_extraction',
          campaign: { id: 'camp-1', name: 'Summer', brandName: 'Acme' },
        });
      const dealStudio = {
        isConfigured: () => opts.configured ?? true,
        addScoutedCreator: add,
      } as unknown as DealStudioService;
      return { service: new ScoutsService(prisma, creators, dealStudio), row, add, creators };
    }

    it("adds a promoted creator to the scout's campaign and records where it went", async () => {
      const { service, row, add } = setup();
      const res = await service.promote('r1', ADMIN);

      expect(add).toHaveBeenCalledWith({
        campaignId: 'camp-1',
        instagramUsername: 'found.creator',
        fullName: 'Found Creator',
        scoutName: 'Alice',
        // Only the URL, de-duplicated and without trailing punctuation.
        reelLinks: ['https://www.instagram.com/reel/AbC'],
        sourceRef: 'r1',
      });
      expect(res.dealStudio).toEqual({
        status: 'added',
        campaignName: 'Acme — Summer',
        creatorId: 77,
      });
      expect(row.dealStudioCreatorId).toBe(77);
      expect(row.dealStudioCampaignId).toBe('camp-1');
      expect(row.dealStudioAddedAt).toBeInstanceOf(Date);
      expect(row.dealStudioError).toBeNull();
    });

    it('reports a creator the campaign already had as a success', async () => {
      const add = jest.fn().mockResolvedValue({
        created: false,
        creatorId: 12,
        status: 'outreach_sent',
        campaign: { id: 'camp-1', name: 'Summer', brandName: 'Acme' },
      });
      const { service } = setup({ add });
      const res = await service.promote('r1', ADMIN);
      expect(res.dealStudio.status).toBe('already_in_campaign');
      expect(res.dealStudio.creatorId).toBe(12);
    });

    it('keeps the promote when Deal Studio fails, and records why', async () => {
      const add = jest
        .fn()
        .mockRejectedValue(new DealStudioError('Deal Studio did not answer within 15s'));
      const { service, row, creators } = setup({ add });

      const res = await service.promote('r1', ADMIN);

      // The Creator Database write stands — the two can't commit together, and
      // the local record is the one that must not be lost.
      expect(creators.upsertFromSource).toHaveBeenCalled();
      expect(row.promotedCreatorId).toBe('creator-1');
      expect(res.creatorId).toBe('creator-1');

      expect(res.dealStudio).toMatchObject({
        status: 'failed',
        error: 'Deal Studio did not answer within 15s',
      });
      expect(row.dealStudioError).toBe('Deal Studio did not answer within 15s');
      expect(row.dealStudioAddedAt).toBeNull();
    });

    it('explains a deleted campaign in terms of what the admin should do', async () => {
      const add = jest.fn().mockRejectedValue(new DealStudioError('404', 404));
      const { service } = setup({ add });
      const res = await service.promote('r1', ADMIN);
      expect(res.dealStudio.error).toMatch(/no longer exists in Deal Studio/);
      expect(res.dealStudio.error).toMatch(/assign the scout a new one, then retry/);
    });

    it('skips a scout with no campaign, without calling Deal Studio', async () => {
      const { service, add } = setup({ campaignId: null });
      const res = await service.promote('r1', ADMIN);
      expect(res.dealStudio).toEqual({ status: 'no_campaign' });
      expect(add).not.toHaveBeenCalled();
    });

    it('stays local when Deal Studio is not connected', async () => {
      const { service, add } = setup({ configured: false });
      const res = await service.promote('r1', ADMIN);
      expect(res.dealStudio).toEqual({ status: 'not_configured' });
      expect(add).not.toHaveBeenCalled();
    });

    it('never sends a row that already went to Deal Studio a second time', async () => {
      const { service, add } = setup({
        stored: {
          dealStudioAddedAt: new Date('2026-09-01'),
          dealStudioCampaignName: 'Acme — Spring',
        },
      });
      const res = await service.promote('r1', ADMIN);
      // Even if the scout was reassigned since: one row goes to one campaign.
      expect(res.dealStudio).toEqual({ status: 'already_added', campaignName: 'Acme — Spring' });
      expect(add).not.toHaveBeenCalled();
    });

    it('retries after a failure and clears the error on success', async () => {
      const add = jest
        .fn()
        .mockRejectedValueOnce(new DealStudioError('Deal Studio GET -> 503: down', 503, true))
        .mockResolvedValueOnce({
          created: true,
          creatorId: 88,
          status: 'pending_extraction',
          campaign: { id: 'camp-1', name: 'Summer', brandName: 'Acme' },
        });
      const { service, row } = setup({ add });

      await service.promote('r1', ADMIN);
      expect(row.dealStudioError).toMatch(/503/);

      const res = await service.retryDealStudio('r1', ADMIN);
      expect(res.dealStudio.status).toBe('added');
      expect(row.dealStudioError).toBeNull();
      expect(row.dealStudioCreatorId).toBe(88);
    });

    it('refuses a retry before the row has been promoted', async () => {
      const { service } = setup();
      await expect(service.retryDealStudio('r1', ADMIN)).rejects.toThrow(/Promote this row/);
    });

    it('refuses a retry from a scout', async () => {
      const { service } = setup();
      await expect(service.retryDealStudio('r1', ALICE)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('reelLinksIn', () => {
    it('pulls out URLs only, trimmed and de-duplicated', () => {
      expect(reelLinksIn(null)).toEqual([]);
      expect(reelLinksIn('no links, just a thought')).toEqual([]);
      expect(
        reelLinksIn(
          'https://instagram.com/reel/a, then https://instagram.com/reel/b! https://instagram.com/reel/a',
        ),
      ).toEqual(['https://instagram.com/reel/a', 'https://instagram.com/reel/b']);
    });
  });

  describe('duplicate detection', () => {
    it('flags a handle already in the Creator DB', async () => {
      const prisma = makePrisma({
        creator: { findUnique: jest.fn().mockResolvedValue({ id: 'c1' }) },
      });
      const service = new ScoutsService(prisma, noCreators, noDealStudio);
      await expect(service.duplicateWarning('taken')).resolves.toMatch(/Creator Database/);
    });

    it('flags a handle already scouted by someone', async () => {
      const prisma = makePrisma({
        scoutEntry: { findFirst: jest.fn().mockResolvedValue({ id: 'other' }) },
      });
      const service = new ScoutsService(prisma, noCreators, noDealStudio);
      await expect(service.duplicateWarning('taken')).resolves.toMatch(/already been scouted/);
    });

    it('stays quiet for a fresh handle or a missing one', async () => {
      const service = new ScoutsService(makePrisma(), noCreators, noDealStudio);
      await expect(service.duplicateWarning('brand.new')).resolves.toBeNull();
      await expect(service.duplicateWarning(null)).resolves.toBeNull();
    });
  });
});
