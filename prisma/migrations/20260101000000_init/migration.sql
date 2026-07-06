-- CreateEnum
CREATE TYPE "NegotiationStatus" AS ENUM ('PENDING', 'NEGOTIATING', 'ACCEPTED', 'REJECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ActivitySource" AS ENUM ('INSTANTLY_DASHBOARD', 'CLAUDE_EXTRACTION', 'EMAIL_SYNC', 'MANUAL_API', 'SYSTEM');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('OUTREACH_SYNC', 'EMAIL_SYNC', 'CLAUDE_EXTRACTION');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instantlyCampaignId" TEXT,
    "brandName" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creators" (
    "id" TEXT NOT NULL,
    "creatorName" TEXT,
    "instagramUsername" TEXT,
    "instagramProfileLink" TEXT,
    "email" TEXT,
    "phoneNumber" TEXT,
    "campaignName" TEXT,
    "campaignId" TEXT,
    "outreachStage" TEXT,
    "assignedManager" TEXT,
    "averageViews" INTEGER,
    "averageLikes" INTEGER,
    "engagementRate" DOUBLE PRECISION,
    "followers" INTEGER,
    "cpm" DOUBLE PRECISION,
    "acceptedRate" DOUBLE PRECISION,
    "quotedRate" DOUBLE PRECISION,
    "currency" TEXT DEFAULT 'USD',
    "numberOfVideos" INTEGER,
    "numberOfStories" INTEGER,
    "numberOfReels" INTEGER,
    "guaranteedViews" INTEGER,
    "deadline" TIMESTAMP(3),
    "deliverablesDescription" TEXT,
    "latestEmailDate" TIMESTAMP(3),
    "lastReplyDate" TIMESTAMP(3),
    "threadId" TEXT,
    "emailStatus" TEXT,
    "inboxRate" DOUBLE PRECISION,
    "spamRate" DOUBLE PRECISION,
    "bounced" BOOLEAN NOT NULL DEFAULT false,
    "opened" BOOLEAN NOT NULL DEFAULT false,
    "replied" BOOLEAN NOT NULL DEFAULT false,
    "status" "NegotiationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_history" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sender" TEXT,
    "recipient" TEXT,
    "subject" TEXT,
    "timestamp" TIMESTAMP(3),
    "rawEmail" TEXT,
    "contentHash" TEXT,
    "claudeJson" JSONB,
    "processedAt" TIMESTAMP(3),
    "creatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT,
    "changedField" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "source" "ActivitySource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failed_jobs" (
    "id" TEXT NOT NULL,
    "jobType" "JobType" NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "failed_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "jobType" "JobType" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "itemsCreated" INTEGER NOT NULL DEFAULT 0,
    "itemsUpdated" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_name_key" ON "campaigns"("name");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_instantlyCampaignId_key" ON "campaigns"("instantlyCampaignId");

-- CreateIndex
CREATE INDEX "campaigns_instantlyCampaignId_idx" ON "campaigns"("instantlyCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "creators_instagramUsername_key" ON "creators"("instagramUsername");

-- CreateIndex
CREATE UNIQUE INDEX "creators_email_key" ON "creators"("email");

-- CreateIndex
CREATE INDEX "creators_creatorName_idx" ON "creators"("creatorName");

-- CreateIndex
CREATE INDEX "creators_campaignId_idx" ON "creators"("campaignId");

-- CreateIndex
CREATE INDEX "creators_assignedManager_idx" ON "creators"("assignedManager");

-- CreateIndex
CREATE INDEX "creators_status_idx" ON "creators"("status");

-- CreateIndex
CREATE INDEX "creators_deadline_idx" ON "creators"("deadline");

-- CreateIndex
CREATE INDEX "creators_updatedAt_idx" ON "creators"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_history_messageId_key" ON "email_history"("messageId");

-- CreateIndex
CREATE INDEX "email_history_threadId_idx" ON "email_history"("threadId");

-- CreateIndex
CREATE INDEX "email_history_creatorId_idx" ON "email_history"("creatorId");

-- CreateIndex
CREATE INDEX "email_history_processedAt_idx" ON "email_history"("processedAt");

-- CreateIndex
CREATE INDEX "activity_logs_creatorId_idx" ON "activity_logs"("creatorId");

-- CreateIndex
CREATE INDEX "activity_logs_source_idx" ON "activity_logs"("source");

-- CreateIndex
CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");

-- CreateIndex
CREATE INDEX "failed_jobs_jobType_idx" ON "failed_jobs"("jobType");

-- CreateIndex
CREATE INDEX "failed_jobs_resolved_idx" ON "failed_jobs"("resolved");

-- CreateIndex
CREATE INDEX "sync_runs_jobType_idx" ON "sync_runs"("jobType");

-- CreateIndex
CREATE INDEX "sync_runs_status_idx" ON "sync_runs"("status");

-- CreateIndex
CREATE INDEX "sync_runs_startedAt_idx" ON "sync_runs"("startedAt");

-- AddForeignKey
ALTER TABLE "creators" ADD CONSTRAINT "creators_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_history" ADD CONSTRAINT "email_history_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
