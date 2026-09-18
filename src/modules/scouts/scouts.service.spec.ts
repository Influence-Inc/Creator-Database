import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { QualificationStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthPrincipal } from '../auth/auth.service';
import { CreatorsService } from '../creators/creators.service';
import { ScoutsService } from './scouts.service';

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

describe('ScoutsService', () => {
  describe('ownership scoping', () => {
    it('always narrows a scout to their own rows, ignoring a requested scoutId', async () => {
      const prisma = makePrisma();
      const service = new ScoutsService(prisma, noCreators);

      await service.list(ALICE, { scoutId: 'someone-else-id' });

      const where = (prisma.scoutEntry.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.scoutId).toBe('alice-id');
    });

    it('lets an admin filter by scout, or see everything', async () => {
      const prisma = makePrisma();
      const service = new ScoutsService(prisma, noCreators);

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
      const service = new ScoutsService(prisma, noCreators);

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
      const service = new ScoutsService(prisma, noCreators);

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
      const service = new ScoutsService(makePrisma(), noCreators);
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
      const service = new ScoutsService(prisma, noCreators);
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
          update: jest.fn().mockResolvedValue({ ...entry, promotedCreatorId: 'creator-1' }),
        },
      });
      const creators = {
        upsertFromSource: jest
          .fn()
          .mockResolvedValue({ creator: { id: 'creator-1' }, created: true }),
      } as unknown as CreatorsService;

      const service = new ScoutsService(prisma, creators);
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

  describe('duplicate detection', () => {
    it('flags a handle already in the Creator DB', async () => {
      const prisma = makePrisma({
        creator: { findUnique: jest.fn().mockResolvedValue({ id: 'c1' }) },
      });
      const service = new ScoutsService(prisma, noCreators);
      await expect(service.duplicateWarning('taken')).resolves.toMatch(/Creator Database/);
    });

    it('flags a handle already scouted by someone', async () => {
      const prisma = makePrisma({
        scoutEntry: { findFirst: jest.fn().mockResolvedValue({ id: 'other' }) },
      });
      const service = new ScoutsService(prisma, noCreators);
      await expect(service.duplicateWarning('taken')).resolves.toMatch(/already been scouted/);
    });

    it('stays quiet for a fresh handle or a missing one', async () => {
      const service = new ScoutsService(makePrisma(), noCreators);
      await expect(service.duplicateWarning('brand.new')).resolves.toBeNull();
      await expect(service.duplicateWarning(null)).resolves.toBeNull();
    });
  });
});
