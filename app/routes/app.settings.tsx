import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Badge, BlockStack, Card, InlineStack, Page, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, APP_HANDLE } from "../shopify.server";
import prisma from "../db.server";
import {
  APP_PRICING_PLANS,
  getShopifyShopId,
  getShopPlanEntitlements,
} from "../services/shopify-app-pricing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopifyShopId = await getShopifyShopId(admin);
  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop, shopifyShopId },
    update: { shopifyShopId },
    select: { id: true },
  });
  const [entitlements, activeCampaigns] = await Promise.all([
    getShopPlanEntitlements(session.shop, shopifyShopId),
    prisma.campaign.findMany({
      where: { shopId: shop.id, status: { in: ["Scheduled", "Running"] } },
      select: { _count: { select: { products: true } } },
    }),
  ]);

  return {
    plan: entitlements.plan,
    activeSubscription: entitlements.activeSubscription,
    activeCampaignCount: activeCampaigns.length,
    activeProductCount: activeCampaigns.reduce((count, campaign) => count + campaign._count.products, 0),
    billingUrl: `https://admin.shopify.com/store/${encodeURIComponent(session.shop.replace(/\.myshopify\.com$/i, ""))}/charges/${encodeURIComponent(APP_HANDLE)}/pricing_plans`,
    plans: Object.values(APP_PRICING_PLANS),
  };
};

export default function Settings() {
  const { plan, activeSubscription, activeCampaignCount, activeProductCount, billingUrl, plans } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Settings" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Your plan</Text>
              <Badge tone={activeSubscription ? "success" : "attention"}>
                {activeSubscription ? plan.name : "Free plan"}
              </Badge>
            </InlineStack>
            <Text as="p" variant="bodyMd">
              {plan.monthlyPrice === 0 ? "Free" : `$${plan.monthlyPrice}/month`}
              {plan.campaignLimit === null ? " · Unlimited active campaigns" : ` · ${plan.campaignLimit} active campaign${plan.campaignLimit === 1 ? "" : "s"}`}
              {plan.productLimit === null ? " · Unlimited products" : ` · ${plan.productLimit} products`}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Current usage: {activeCampaignCount} active campaigns and {activeProductCount} products in those campaigns.
            </Text>
            <a href={billingUrl} target="_top" rel="noreferrer">
              Manage plan in Shopify
            </a>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Available plans</Text>
            {plans.map((availablePlan) => (
              <InlineStack key={availablePlan.handle} align="space-between" blockAlign="center" wrap>
                <Text as="p" variant="bodyMd" fontWeight="semibold">{availablePlan.name}</Text>
                <Text as="p" variant="bodyMd">
                  {availablePlan.monthlyPrice === 0 ? "Free" : `$${availablePlan.monthlyPrice}/month`}
                  {availablePlan.campaignLimit === null ? " · Unlimited campaigns" : ` · ${availablePlan.campaignLimit} active campaign${availablePlan.campaignLimit === 1 ? "" : "s"}`}
                  {availablePlan.productLimit === null ? "" : ` · ${availablePlan.productLimit} products`}
                </Text>
              </InlineStack>
            ))}
            <Text as="p" variant="bodySm" tone="subdued">
              Pro includes the same campaign capacity as Growth; premium features can be added to that plan later.
            </Text>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Store settings</Text>
            <Text as="p" variant="bodyMd">PricePilot preferences for your store will be configured here.</Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
