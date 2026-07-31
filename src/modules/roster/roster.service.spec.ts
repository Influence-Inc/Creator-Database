// Guards RosterService.updateDetails' unique-conflict reporting. When an email
// or Instagram handle edit hits the @unique constraint, the admin must be told
// the EXACT field that collided and which creator holds it — not the ambiguous
// "email or Instagram handle" that had them changing the email while the real
// clash was on the untouched handle.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RosterService } from './roster.service';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['email'] },
  });
}

// Fake Prisma with just the methods updateDetails + describeUniqueConflict use.
// `conflictOwners` lets a test say "a findFirst on this field returns a clashing
// creator". creator.update throws P2002 when `updateThrows` is set.
function buildPrisma(opts: {
  creator: { id: string } | null;
  updateThrows?: boolean;
  emailOwner?: { creatorName: string | null; instagramUsername: string | null; email: string | null } | null;
  igOwner?: { creatorName: string | null; instagramUsername: string | null; email: string | null } | null;
}) {
  const creatorFindFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    if ('email' in where) return opts.emailOwner ?? null;
    if ('instagramUsername' in where) return opts.igOwner ?? null;
    return null;
  });
  const creatorUpdate = jest.fn(async (_args: { where: unknown; data: Record<string, unknown> }) => {
    if (opts.updateThrows) throw p2002();
    return opts.creator;
  });
  const prisma = {
    creator: {
      findUnique: jest.fn(async () => opts.creator),
      update: creatorUpdate,
      findFirst: creatorFindFirst,
    },
    contract: { findFirst: jest.fn(async () => null), update: jest.fn() },
  } as unknown as PrismaService;
  return { prisma, creatorUpdate, creatorFindFirst };
}

function svcWithStubbedProfile(prisma: PrismaService): RosterService {
  const svc = new RosterService(prisma);
  jest
    .spyOn(svc as unknown as { profile: (id: string) => Promise<unknown> }, 'profile')
    .mockResolvedValue({ ok: true });
  return svc;
}

describe('RosterService.updateDetails — unique-conflict messages', () => {
  it('names the EMAIL and the creator that already holds it', async () => {
    const { prisma } = buildPrisma({
      creator: { id: 'c1' },
      updateThrows: true,
      emailOwner: { creatorName: 'Existing Person', instagramUsername: null, email: 'taken@example.com' },
    });
    const svc = svcWithStubbedProfile(prisma);

    await expect(
      svc.updateDetails('c1', { contact: { email: 'taken@example.com' } }),
    ).rejects.toThrow(/the email taken@example\.com is already used by Existing Person/);
  });

  it('names the INSTAGRAM HANDLE when the collision is on the untouched handle, not the email', async () => {
    // The real-world case: admin changes only the email, but the form re-sent
    // the handle too, and THAT is what clashes. The message must point at the
    // handle so they stop blaming the (perfectly fine) new email.
    const { prisma } = buildPrisma({
      creator: { id: 'c1' },
      updateThrows: true,
      emailOwner: null, // the email is NOT taken
      igOwner: { creatorName: null, instagramUsername: 'cockroachjantaparty', email: 'other@x.com' },
    });
    const svc = svcWithStubbedProfile(prisma);

    await expect(
      svc.updateDetails('c1', {
        contact: { email: 'brand-new@example.com', instagramUsername: 'cockroachjantaparty' },
      }),
    ).rejects.toThrow(/Instagram handle @cockroachjantaparty is already used by @cockroachjantaparty/);
  });

  it('falls back to the generic message when P2002 fires but no owner row is found', async () => {
    const { prisma } = buildPrisma({
      creator: { id: 'c1' },
      updateThrows: true,
      emailOwner: null,
      igOwner: null,
    });
    const svc = svcWithStubbedProfile(prisma);

    await expect(
      svc.updateDetails('c1', { contact: { email: 'x@example.com' } }),
    ).rejects.toThrow(/already assigned to another creator/);
  });

  it('a normal email change with no clash saves fine (P2002 not thrown)', async () => {
    const { prisma, creatorUpdate } = buildPrisma({
      creator: { id: 'c1' },
      updateThrows: false,
    });
    const svc = svcWithStubbedProfile(prisma);

    await expect(
      svc.updateDetails('c1', { contact: { email: 'fresh@example.com' } }),
    ).resolves.toEqual({ ok: true });
    expect(creatorUpdate).toHaveBeenCalledTimes(1);
    expect(creatorUpdate.mock.calls[0][0].data).toEqual({ email: 'fresh@example.com' });
  });

  it('throws NotFound for a missing creator', async () => {
    const { prisma } = buildPrisma({ creator: null });
    const svc = svcWithStubbedProfile(prisma);
    await expect(
      svc.updateDetails('missing', { contact: { email: 'x@example.com' } }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the fallback is a BadRequestException (400, not 500)', async () => {
    const { prisma } = buildPrisma({ creator: { id: 'c1' }, updateThrows: true });
    const svc = svcWithStubbedProfile(prisma);
    await expect(
      svc.updateDetails('c1', { contact: { email: 'x@example.com' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
