// Guards RosterService.updateDetails — specifically the bug where the /public
// admin edit UI's Contact card couldn't save because the frontend always
// echoes an empty address block, which the old backend interpreted as "you
// want to save contract-side data" and rejected with "no contract yet" for any
// creator without a contract. These tests lock in that a save with only email/
// phone changes (and empty-string echoes for the rest) succeeds regardless of
// whether the creator has a contract.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RosterService } from './roster.service';

// Minimal fake PrismaService: only the methods updateDetails touches.
// $transaction executes the callback synchronously, passing the same fake as
// the tx client — matches the pattern in creators.service.spec.ts.
type CreatorRow = { id: string; email: string | null; phoneNumber: string | null };
type ContractRow = {
  id: string;
  creatorId: string;
  paymentDetails: unknown;
  addressLine1?: string | null;
};

function buildPrismaFake(seed: {
  creator: CreatorRow | null;
  contract: ContractRow | null;
}) {
  const creatorUpdate = jest.fn(async ({ data }: { data: Partial<CreatorRow> }) => {
    if (seed.creator) Object.assign(seed.creator, data);
    return seed.creator!;
  });
  const contractUpdate = jest.fn(async ({ data }: { data: Partial<ContractRow> }) => {
    if (seed.contract) Object.assign(seed.contract, data);
    return seed.contract!;
  });
  const contractFindFirst = jest.fn(async () => seed.contract);
  const creatorFindUnique = jest.fn(async () => seed.creator);

  const tx = {
    creator: { update: creatorUpdate, findUnique: creatorFindUnique },
    contract: { update: contractUpdate, findFirst: contractFindFirst },
  };
  const prisma = {
    ...tx,
    $transaction: (cb: (t: unknown) => unknown) => cb(tx),
  } as unknown as PrismaService;

  return { prisma, creatorUpdate, contractUpdate, contractFindFirst };
}

// Stub profile() so we don't have to fake the full read model.
function withStubbedProfile<T extends RosterService>(svc: T): T {
  jest.spyOn(svc as unknown as { profile: (id: string) => Promise<unknown> }, 'profile')
    .mockResolvedValue({ ok: true });
  return svc;
}

describe('RosterService.updateDetails', () => {
  it('THE BUG: saving a new email on a creator WITHOUT a contract now succeeds (was 400)', async () => {
    // The frontend edit form always emits the whole contact object — including
    // an empty-string address block — even when the user only changed email.
    // Pre-fix: `wantsContractEdit` triggered on `contact.address !== undefined`
    // and threw "no contract yet". Now: empty echoes are ignored.
    const seed = {
      creator: { id: 'c1', email: 'old@example.com', phoneNumber: null },
      contract: null,
    };
    const { prisma, creatorUpdate, contractFindFirst } = buildPrismaFake(seed);
    const svc = withStubbedProfile(new RosterService(prisma));

    await expect(
      svc.updateDetails('c1', {
        contact: {
          email: 'new@example.com',
          phone: '',
          address: { line1: '', line2: '', city: '', state: '', postalCode: '', country: '' },
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(creatorUpdate).toHaveBeenCalledTimes(1);
    expect(creatorUpdate.mock.calls[0][0].data).toEqual({
      email: 'new@example.com',
      phoneNumber: null,
    });
    // No contract to look up? The tx still consults contract.findFirst inside
    // (harmless when null), and MUST NOT throw or attempt an update.
    expect(contractFindFirst).toHaveBeenCalledTimes(1);
  });

  it('still rejects when the caller actually sends REAL address data but there is no contract', async () => {
    const { prisma } = buildPrismaFake({
      creator: { id: 'c1', email: 'x@example.com', phoneNumber: null },
      contract: null,
    });
    const svc = withStubbedProfile(new RosterService(prisma));

    await expect(
      svc.updateDetails('c1', {
        contact: {
          email: 'x@example.com',
          address: { line1: '123 Real St', city: 'SF' },
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes address to the latest contract when one exists (real address, real contract)', async () => {
    const seed = {
      creator: { id: 'c1', email: 'x@example.com', phoneNumber: null },
      contract: { id: 'k1', creatorId: 'c1', paymentDetails: null as unknown },
    };
    const { prisma, contractUpdate } = buildPrismaFake(seed);
    const svc = withStubbedProfile(new RosterService(prisma));

    await svc.updateDetails('c1', {
      contact: {
        email: 'x@example.com',
        address: { line1: '123 Real St', line2: '', city: 'SF', state: '', postalCode: '', country: '' },
      },
    });

    expect(contractUpdate).toHaveBeenCalledTimes(1);
    const data = contractUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.addressLine1).toBe('123 Real St');
    expect(data.addressCity).toBe('SF');
    // Empty strings pass through as empty strings (pre-existing behavior of
    // `?? null`, which only converts null/undefined). Not the ideal shape but
    // preserving it in this fix — normalizing "" → null across the address
    // block is a separate cleanup.
    expect(data.addressState).toBe('');
  });

  it('throws NotFound for a missing creator without touching the DB writes', async () => {
    const { prisma, creatorUpdate } = buildPrismaFake({ creator: null, contract: null });
    const svc = withStubbedProfile(new RosterService(prisma));

    await expect(
      svc.updateDetails('missing', { contact: { email: 'x@example.com' } }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(creatorUpdate).not.toHaveBeenCalled();
  });

  it('phone-only save on a no-contract creator no longer forces the contract requirement', async () => {
    // Pre-fix: `contact.phone !== undefined` alone triggered wantsContractEdit,
    // so setting a phone on a creator without a contract also 400'd.
    const seed = {
      creator: { id: 'c1', email: 'x@example.com', phoneNumber: null },
      contract: null,
    };
    const { prisma, creatorUpdate } = buildPrismaFake(seed);
    const svc = withStubbedProfile(new RosterService(prisma));

    await expect(
      svc.updateDetails('c1', { contact: { phone: '+15551234' } }),
    ).resolves.toEqual({ ok: true });
    expect(creatorUpdate.mock.calls[0][0].data).toEqual({ phoneNumber: '+15551234' });
  });
});
