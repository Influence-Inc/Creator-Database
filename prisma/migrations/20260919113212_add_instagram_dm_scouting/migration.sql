-- CreateEnum
CREATE TYPE "InstagramMessageStatus" AS ENUM ('APPLIED', 'NO_LINKS', 'UNMATCHED_SENDER', 'FAILED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "instagramHandle" TEXT,
ADD COLUMN     "instagramUserId" TEXT;

-- CreateTable
CREATE TABLE "instagram_messages" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderUsername" TEXT,
    "text" TEXT,
    "profileLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reelLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "otherLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "InstagramMessageStatus" NOT NULL,
    "statusNote" TEXT,
    "scoutId" TEXT,
    "entryId" TEXT,
    "raw" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instagram_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instagram_messages_messageId_key" ON "instagram_messages"("messageId");

-- CreateIndex
CREATE INDEX "instagram_messages_status_idx" ON "instagram_messages"("status");

-- CreateIndex
CREATE INDEX "instagram_messages_senderId_idx" ON "instagram_messages"("senderId");

-- CreateIndex
CREATE INDEX "instagram_messages_scoutId_idx" ON "instagram_messages"("scoutId");

-- CreateIndex
CREATE INDEX "instagram_messages_receivedAt_idx" ON "instagram_messages"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_instagramHandle_key" ON "users"("instagramHandle");

-- CreateIndex
CREATE UNIQUE INDEX "users_instagramUserId_key" ON "users"("instagramUserId");

-- CreateIndex
CREATE INDEX "users_instagramUserId_idx" ON "users"("instagramUserId");

-- AddForeignKey
ALTER TABLE "instagram_messages" ADD CONSTRAINT "instagram_messages_scoutId_fkey" FOREIGN KEY ("scoutId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instagram_messages" ADD CONSTRAINT "instagram_messages_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "scout_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

