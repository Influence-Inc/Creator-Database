-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING', 'SIGNED', 'COMPLETED');

-- AlterEnum
ALTER TYPE "ActivitySource" ADD VALUE 'CONTRACT_SIGNED';

-- CreateTable
CREATE TABLE "contracts" (
    "id" TEXT NOT NULL,
    "contractRef" TEXT NOT NULL,
    "contractUrl" TEXT,
    "creatorId" TEXT NOT NULL,
    "brandName" TEXT,
    "campaignName" TEXT,
    "platform" TEXT,
    "deliverables" TEXT,
    "numberOfDeliverables" INTEGER,
    "timeline" TEXT,
    "deadline" TIMESTAMP(3),
    "usageRights" TEXT,
    "exclusivity" TEXT,
    "guaranteedViews" INTEGER,
    "compensation" DOUBLE PRECISION,
    "currency" TEXT DEFAULT 'USD',
    "paymentTerms" TEXT,
    "specialNotes" TEXT,
    "additionalTerms" JSONB,
    "status" "ContractStatus" NOT NULL DEFAULT 'PENDING',
    "signerName" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contracts_contractRef_key" ON "contracts"("contractRef");

-- CreateIndex
CREATE INDEX "contracts_creatorId_idx" ON "contracts"("creatorId");

-- CreateIndex
CREATE INDEX "contracts_status_idx" ON "contracts"("status");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
