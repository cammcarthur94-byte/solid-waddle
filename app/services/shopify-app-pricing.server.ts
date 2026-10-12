import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";

export const APP_PRICING_PLANS = {
  free: { handle: "free", name: "Free", monthlyPrice: 0, campaignLimit: 1, productLimit: 20 },
  starter: { handle: "starter", name: "Starter", monthlyPrice: 9, campaignLimit: 10, productLimit: 500 },
  growth: { handle: "growth", name: "Growth", monthlyPrice: 19, campaignLimit: null, productLimit: null },
  pro: { handle: "pro", name: "Pro", monthlyPrice: 39, campaignLimit: null, productLimit: null },
} as const;

export type AppPricingPlan = (typeof APP_PRICING_PLANS)[keyof typeof APP_PRICING_PLANS];

const PLAN_BY_HANDLE = new Map<string, AppPricingPlan>(
  Object.values(APP_PRICING_PLANS).map((plan) => [plan.handle, plan]),
);
const CACHE_TTL_MS = 5 * 60 * 1000;
const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      items { handle }
    }
  }
`;

type ActiveSubscriptionResponse = {
  data?: {
    activeSubscription: { items: Array<{ handle: string }> } | null;
  };
  errors?: Array<{ message?: string }>;
};

export class ShopifyAppPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyAppPricingError";
  }
}

export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

export const PREMIUM_FEATURES = [
  "recurringCampaigns",
  "campaignTemplates",
  "compareAtScheduling",
  "collectionCampaigns",
  "oneClickRollback",
  "bulkDuplicateCampaigns",
] as const;

export type PremiumFeature = (typeof PREMIUM_FEATURES)[number];

export function hasPremiumFeatures(plan: AppPricingPlan): boolean {
  return plan.handle === APP_PRICING_PLANS.pro.handle;
}

export function assertPremiumFeature(plan: AppPricingPlan, feature: PremiumFeature): void {
  if (!hasPremiumFeatures(plan)) {
    throw new PlanLimitError(`${feature} is available on the Pro plan.`);
  }
}

export interface ShopPlanEntitlements {
  plan: AppPricingPlan;
  activeSubscription: boolean;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ShopifyAppPricingError(`Missing required Shopify App Pricing setting ${name}.`);
  return value;
}

function getPlanFromHandles(handles: string[]): AppPricingPlan | null {
  for (const handle of handles) {
    const plan = PLAN_BY_HANDLE.get(handle);
    if (plan) return plan;
  }
  return null;
}

/** Enforce per-campaign product and aggregate limits within a database transaction. */
export async function enforceCampaignPlanLimits(
  tx: PrismaTypes.TransactionClient,
  shopId: string,
  plan: AppPricingPlan,
  productCount: number,
  options: {
    active?: boolean;
    ignoreCampaignId?: string;
    lock?: boolean;
    enforceCampaignLimit?: boolean;
  } = {},
): Promise<void> {
  if (plan.productLimit !== null && productCount > plan.productLimit) {
    throw new PlanLimitError(`${plan.name} allows up to ${plan.productLimit} products per campaign.`);
  }
  if (options.lock) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Shop" WHERE "id" = ${shopId} FOR UPDATE`);
  }

  const shop = await tx.shop.findUnique({
    where: { id: shopId },
    select: { billingPlanHandle: true, billingPlanCheckedAt: true },
  });
  if (!shop?.billingPlanCheckedAt || Date.now() - shop.billingPlanCheckedAt.getTime() >= CACHE_TTL_MS) {
    throw new ShopifyAppPricingError("Shopify App Pricing entitlement is not freshly verified; reload and retry.");
  }
  if (shop.billingPlanHandle !== plan.handle) {
    throw new ShopifyAppPricingError("Shopify App Pricing plan changed during this request; reload and retry.");
  }
  if (!options.active) return;

  const activeCampaigns = await tx.campaign.findMany({
    where: {
      shopId,
      status: { in: ["Scheduled", "Running"] },
      ...(options.ignoreCampaignId ? { id: { not: options.ignoreCampaignId } } : {}),
    },
    select: { id: true },
  });
  const activeCampaignIds = activeCampaigns.map(({ id }) => id);
  const activeProductCount = activeCampaignIds.length
    ? await tx.campaignProduct.count({ where: { campaignId: { in: activeCampaignIds } } })
    : 0;

  if (options.enforceCampaignLimit && plan.campaignLimit !== null && activeCampaigns.length >= plan.campaignLimit) {
    throw new PlanLimitError(
      `${plan.name} allows up to ${plan.campaignLimit} active campaign${plan.campaignLimit === 1 ? "" : "s"}.`,
    );
  }

  const proposedProductCount = activeProductCount + productCount;
  if (plan.productLimit !== null && proposedProductCount > plan.productLimit) {
    throw new PlanLimitError(
      `${plan.name} allows up to ${plan.productLimit} products across active campaigns; ${activeProductCount} are already in use.`,
    );
  }
}

export async function getShopifyShopId(admin: AdminApiContext): Promise<string> {
  const response = await admin.graphql(`#graphql
    query BillingShopId { shop { id } }
  `);
  const result = await response.json() as {
    data?: { shop?: { id?: string } };
    errors?: Array<{ message?: string }>;
  };
  const shopId = result.data?.shop?.id;
  if (!response.ok || result.errors?.length || !shopId) {
    throw new ShopifyAppPricingError("Could not verify the Shopify shop for billing.");
  }
  return shopId;
}

/** Query Shopify's Partner Active Subscription API; failed checks never grant entitlements. */
export async function getShopPlanEntitlements(
  shopDomain: string,
  shopifyShopId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ShopPlanEntitlements> {
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    create: { shopDomain, shopifyShopId },
    update: { shopifyShopId },
    select: {
      id: true,
      billingPlanHandle: true,
      billingActive: true,
      billingPlanCheckedAt: true,
    },
  });
  const cacheFresh = shop.billingPlanCheckedAt &&
    Date.now() - shop.billingPlanCheckedAt.getTime() < CACHE_TTL_MS;
  if (!options.forceRefresh && cacheFresh) {
    const cachedPlan = shop.billingPlanHandle
      ? PLAN_BY_HANDLE.get(shop.billingPlanHandle)
      : null;
    if (cachedPlan) {
      return { plan: cachedPlan, activeSubscription: shop.billingActive };
    }
  }

  const organizationId = requiredEnv("SHOPIFY_PARTNER_ORG_ID");
  const accessToken = requiredEnv("SHOPIFY_PARTNER_API_ACCESS_TOKEN");
  const appId = requiredEnv("SHOPIFY_APP_GID");
  const apiVersion = process.env.SHOPIFY_PARTNER_API_VERSION ?? "2026-07";
  const response = await fetch(
    `https://partners.shopify.com/${encodeURIComponent(organizationId)}/api/${encodeURIComponent(apiVersion)}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: ACTIVE_SUBSCRIPTION_QUERY,
        variables: { appId, shopId: shopifyShopId },
      }),
    },
  );

  let result: ActiveSubscriptionResponse;
  try {
    result = await response.json() as ActiveSubscriptionResponse;
  } catch {
    throw new ShopifyAppPricingError(`Partner API returned an invalid response (${response.status}).`);
  }
  if (!response.ok || result.errors?.length || !result.data) {
    const errors = result.errors?.map((error) => error.message ?? "Partner API error").join("; ");
    throw new ShopifyAppPricingError(`Partner API subscription check failed: ${errors ?? response.status}.`);
  }

  const handles = result.data.activeSubscription?.items.map((item) => item.handle) ?? [];
  const plan = getPlanFromHandles(handles);
  if (result.data.activeSubscription && !plan) {
    throw new ShopifyAppPricingError(
      `Active Shopify subscription has unrecognized plan handle(s): ${handles.join(", ") || "none"}.`,
    );
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      billingPlanHandle: plan?.handle ?? APP_PRICING_PLANS.free.handle,
      billingActive: Boolean(result.data.activeSubscription),
      billingPlanCheckedAt: new Date(),
    },
  });
  return {
    plan: plan ?? APP_PRICING_PLANS.free,
    activeSubscription: Boolean(result.data.activeSubscription),
  };
}
