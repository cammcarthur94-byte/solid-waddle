ALTER TABLE "Shop"
ADD COLUMN "shopifyShopId" TEXT,
ADD COLUMN "billingPlanHandle" TEXT,
ADD COLUMN "billingActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "billingPlanCheckedAt" TIMESTAMP(3);

CREATE INDEX "Shop_shopifyShopId_idx" ON "Shop"("shopifyShopId");
