-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'SCOUT');

-- CreateEnum
CREATE TYPE "ScoutGender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "QualificationStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'SCOUT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scout_entries" (
    "id" TEXT NOT NULL,
    "scoutId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "instagramProfileLink" TEXT NOT NULL,
    "instagramUsername" TEXT,
    "reelIdeas" TEXT,
    "approxAge" INTEGER,
    "gender" "ScoutGender",
    "country" TEXT,
    "language" TEXT,
    "qualification" "QualificationStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "promotedCreatorId" TEXT,
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scout_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_isActive_idx" ON "users"("isActive");

-- CreateIndex
CREATE INDEX "scout_entries_scoutId_idx" ON "scout_entries"("scoutId");

-- CreateIndex
CREATE INDEX "scout_entries_qualification_idx" ON "scout_entries"("qualification");

-- CreateIndex
CREATE INDEX "scout_entries_instagramUsername_idx" ON "scout_entries"("instagramUsername");

-- CreateIndex
CREATE INDEX "scout_entries_createdAt_idx" ON "scout_entries"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "scout_entries_scoutId_rowNumber_key" ON "scout_entries"("scoutId", "rowNumber");

-- AddForeignKey
ALTER TABLE "scout_entries" ADD CONSTRAINT "scout_entries_scoutId_fkey" FOREIGN KEY ("scoutId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scout_entries" ADD CONSTRAINT "scout_entries_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scout_entries" ADD CONSTRAINT "scout_entries_promotedCreatorId_fkey" FOREIGN KEY ("promotedCreatorId") REFERENCES "creators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
