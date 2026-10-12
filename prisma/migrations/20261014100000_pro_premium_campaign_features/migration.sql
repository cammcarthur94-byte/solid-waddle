ALTER TABLE "Campaign"
ADD COLUMN "recurrenceIntervalDays" INTEGER,
ADD COLUMN "recurrenceEndsAt" TIMESTAMP(3),
ADD COLUMN "collectionId" TEXT,
ADD COLUMN "collectionTitle" TEXT;

ALTER TABLE "CampaignProduct"
ADD COLUMN "originalCompareAtPrice" DECIMAL(10,2),
ADD COLUMN "targetCompareAtPrice" DECIMAL(10,2);

CREATE TABLE "CampaignTemplate" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CampaignTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CampaignTemplate_shopId_createdAt_idx" ON "CampaignTemplate"("shopId", "createdAt");
ALTER TABLE "CampaignTemplate" ADD CONSTRAINT "CampaignTemplate_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
