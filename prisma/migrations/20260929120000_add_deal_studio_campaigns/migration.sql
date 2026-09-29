-- AlterTable
ALTER TABLE "users" ADD COLUMN     "dealStudioCampaignId" TEXT,
ADD COLUMN     "dealStudioCampaignName" TEXT;

-- AlterTable
ALTER TABLE "scout_entries" ADD COLUMN     "dealStudioAddedAt" TIMESTAMP(3),
ADD COLUMN     "dealStudioCampaignId" TEXT,
ADD COLUMN     "dealStudioCampaignName" TEXT,
ADD COLUMN     "dealStudioCreatorId" INTEGER,
ADD COLUMN     "dealStudioError" TEXT;

