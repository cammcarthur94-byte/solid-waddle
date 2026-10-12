import type {
  ActivityLog,
  Campaign,
  CampaignProduct,
  Prisma,
  Shop,
} from "@prisma/client";

export type { ActivityLog, Campaign, CampaignProduct, Shop };
export type { CampaignStatus } from "./campaign-status";

export type CampaignWithProducts = Prisma.CampaignGetPayload<{
  include: { products: true };
}>;

export type CampaignWithProductsAndShop = Prisma.CampaignGetPayload<{
  include: { products: true; shop: true };
}>;

export type CreateCampaignInput = Pick<
  Campaign,
  "shopId" | "name" | "description" | "startDate" | "endDate" | "status"
>;

export type CreateCampaignProductInput = Pick<
  CampaignProduct,
  | "campaignId"
  | "shopifyProductId"
  | "shopifyVariantId"
  | "originalPrice"
  | "targetPrice"
>;
