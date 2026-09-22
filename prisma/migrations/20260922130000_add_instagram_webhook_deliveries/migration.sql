-- CreateTable
CREATE TABLE "instagram_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instagram_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instagram_webhook_deliveries_at_idx" ON "instagram_webhook_deliveries"("at");
