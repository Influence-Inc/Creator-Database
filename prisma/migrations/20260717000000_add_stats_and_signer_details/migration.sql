-- AlterEnum
ALTER TYPE "ActivitySource" ADD VALUE 'STATS_SYNC';

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'STATS_SYNC';

-- AlterTable
ALTER TABLE "creators" ADD COLUMN "riskLevel" TEXT;

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN "signerEmail" TEXT,
ADD COLUMN "signerPhone" TEXT,
ADD COLUMN "signerGender" TEXT,
ADD COLUMN "signerSignedDate" TIMESTAMP(3),
ADD COLUMN "signatureImage" TEXT,
ADD COLUMN "addressLine1" TEXT,
ADD COLUMN "addressLine2" TEXT,
ADD COLUMN "addressCity" TEXT,
ADD COLUMN "addressState" TEXT,
ADD COLUMN "addressPostalCode" TEXT,
ADD COLUMN "addressCountry" TEXT,
ADD COLUMN "paymentDetails" JSONB;

-- CreateTable
CREATE TABLE "creator_stats" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "statsCampaignId" TEXT NOT NULL,
    "campaignName" TEXT,
    "brandName" TEXT,
    "platforms" TEXT,
    "totalViews" INTEGER,
    "totalLikes" INTEGER,
    "totalComments" INTEGER,
    "postCount" INTEGER,
    "videosPosted" INTEGER,
    "riskLevel" TEXT,
    "bookedCpm" DOUBLE PRECISION,
    "realizedCpm" DOUBLE PRECISION,
    "budget" DOUBLE PRECISION,
    "grossPay" DOUBLE PRECISION,
    "creatorAsk" DOUBLE PRECISION,
    "currency" TEXT DEFAULT 'USD',
    "paidAdRights" TEXT,
    "minViews" INTEGER,
    "minVideos" INTEGER,
    "deliverablesComplete" BOOLEAN,
    "deadline" TIMESTAMP(3),
    "videos" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creator_stats_creatorId_idx" ON "creator_stats"("creatorId");

-- CreateIndex
CREATE INDEX "creator_stats_statsCampaignId_idx" ON "creator_stats"("statsCampaignId");

-- CreateIndex
CREATE INDEX "creator_stats_riskLevel_idx" ON "creator_stats"("riskLevel");

-- CreateIndex
CREATE UNIQUE INDEX "creator_stats_creatorId_statsCampaignId_key" ON "creator_stats"("creatorId", "statsCampaignId");

-- AddForeignKey
ALTER TABLE "creator_stats" ADD CONSTRAINT "creator_stats_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
