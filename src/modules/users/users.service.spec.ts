import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DealStudioService } from '../../integrations/deal-studio/deal-studio.service';
import { UsersService } from './users.service';

const SCOUT = {
  id: 'u1',
  username: 'scout.alice',
  displayName: 'Alice',
  role: UserRole.SCOUT,
  isActive: true,
  lastLoginAt: null,
  createdAt: new Date('2026-09-01'),
  instagramHandle: null,
  instagramUserId: null,
  dealStudioCampaignId: null,
  dealStudioCampaignName: null,
};

function setup(dealStudio: Partial<DealStudioService>) {
  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...SCOUT,
    ...data,
  }));
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(SCOUT), update },
  } as unknown as PrismaService;
  const service = new UsersService(prisma, dealStudio as DealStudioService);
  return { service, update };
}

const CAMPAIGNS = [
  { id: 'camp-1', name: 'Summer', brandName: 'Acme' },
  { id: 'camp-2', name: 'Solo', brandName: 'Solo' },
];

describe('UsersService — Deal Studio campaign', () => {
  const connected = {
    isConfigured: () => true,
    listCampaigns: jest.fn().mockResolvedValue(CAMPAIGNS),
  };

  it("stores the campaign under Deal Studio's own name for it", async () => {
    const { service, update } = setup(connected);
    const out = await service.update('u1', { dealStudioCampaignId: 'camp-1' });

    expect(update.mock.calls[0][0].data).toMatchObject({
      dealStudioCampaignId: 'camp-1',
      dealStudioCampaignName: 'Acme — Summer',
    });
    expect(out.dealStudioCampaignName).toBe('Acme — Summer');
  });

  it('does not repeat the brand when it is the campaign name', async () => {
    const { service, update } = setup(connected);
    await service.update('u1', { dealStudioCampaignId: 'camp-2' });
    expect(update.mock.calls[0][0].data.dealStudioCampaignName).toBe('Solo');
  });

  it('refuses a campaign Deal Studio does not have, now rather than at promote', async () => {
    const { service, update } = setup(connected);
    await expect(service.update('u1', { dealStudioCampaignId: 'nope' })).rejects.toThrow(
      /does not exist in Deal Studio/,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('clears the assignment with an empty value, without calling Deal Studio', async () => {
    const listCampaigns = jest.fn();
    const { service, update } = setup({ isConfigured: () => true, listCampaigns });
    await service.update('u1', { dealStudioCampaignId: '' });
    expect(update.mock.calls[0][0].data).toMatchObject({
      dealStudioCampaignId: null,
      dealStudioCampaignName: null,
    });
    expect(listCampaigns).not.toHaveBeenCalled();
  });

  it('explains that Deal Studio is not connected', async () => {
    const { service } = setup({ isConfigured: () => false });
    await expect(service.update('u1', { dealStudioCampaignId: 'camp-1' })).rejects.toThrow(
      /DEAL_STUDIO_URL/,
    );
  });

  it('turns an unreachable Deal Studio into a readable refusal', async () => {
    const { service } = setup({
      isConfigured: () => true,
      listCampaigns: jest
        .fn()
        .mockRejectedValue(new Error('Could not reach Deal Studio: fetch failed')),
    });
    const err = await service
      .update('u1', { dealStudioCampaignId: 'camp-1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/Could not load campaigns from Deal Studio/);
  });

  it('leaves the assignment alone when the field is not sent', async () => {
    const listCampaigns = jest.fn();
    const { service, update } = setup({ isConfigured: () => true, listCampaigns });
    await service.update('u1', { displayName: 'Alice B' });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('dealStudioCampaignId');
    expect(listCampaigns).not.toHaveBeenCalled();
  });
});
