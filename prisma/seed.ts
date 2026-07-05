/**
 * Optional development seed. Populates a demo campaign + creator so the REST
 * API returns something before the first real sync. Safe to run repeatedly
 * (uses upserts). Run with `npm run db:seed`.
 */
import { PrismaClient, NegotiationStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const campaign = await prisma.campaign.upsert({
    where: { name: 'Summer Launch 2026' },
    update: {},
    create: {
      name: 'Summer Launch 2026',
      brandName: 'Acme Skincare',
      instantlyCampaignId: 'demo-campaign-0001',
    },
  });

  await prisma.creator.upsert({
    where: { email: 'demo.creator@example.com' },
    update: {},
    create: {
      creatorName: 'Demo Creator',
      instagramUsername: 'democreator',
      instagramProfileLink: 'https://instagram.com/democreator',
      email: 'demo.creator@example.com',
      campaignId: campaign.id,
      campaignName: campaign.name,
      assignedManager: 'Jennifer',
      averageViews: 250_000,
      cpm: 15,
      acceptedRate: 40_000,
      currency: 'USD',
      numberOfReels: 2,
      guaranteedViews: 2_000_000,
      status: NegotiationStatus.ACCEPTED,
    },
  });

  // eslint-disable-next-line no-console
  console.log('Seed complete.');
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
