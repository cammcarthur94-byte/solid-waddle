import { json, redirect } from "@remix-run/node";
import { useLoaderData, Link, useNavigate } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Button, Badge } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, APP_HANDLE } from "../shopify.server";
import prisma from "../db.server";
import { getShopifyShopId, getShopPlanEntitlements, APP_PRICING_PLANS } from "../services/shopify-app-pricing.server";

export const loader = async ({ request }: { request: Request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shopifyShopId = await getShopifyShopId(admin);
  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop, shopifyShopId },
    update: { shopifyShopId },
    select: { id: true },
  });
  const entitlements = await getShopPlanEntitlements(session.shop, shopifyShopId);
  const billingUrl = `https://admin.shopify.com/store/${encodeURIComponent(session.shop.replace(/\\.myshopify\\.com$/i, ""))}/charges/${encodeURIComponent(APP_HANDLE)}/pricing_plans`;
  return json({
    currentPlan: entitlements.plan,
    billingUrl,
    plans: Object.values(APP_PRICING_PLANS),
  });
};

export const action = async ({ request }: { request: Request }) => {
  const form = await request.formData();
  const planHandle = form.get("plan") as string;
  // Redirect merchant to Shopify billing UI; Shopify handles the upgrade.
  const redirectUrl = "/app/settings";
  return redirect(redirectUrl);
};

export default function Upgrade() {
  const { currentPlan, billingUrl, plans } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const handleUpgrade = (planHandle: string) => {
    // Open Shopify billing UI in a new tab for the selected plan.
    window.open(billingUrl, "_blank");
    navigate("/app/settings");
  };

  return (
    <Page title="Upgrade Plan">
      <TitleBar title="Upgrade Plan" />
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Current Plan</Text>
              <Badge tone="info">{currentPlan.name}</Badge>
            </InlineStack>
            <Text as="p" variant="bodyMd">Select a new plan to upgrade your subscription.</Text>
            {plans.map((plan) => (
              <InlineStack key={plan.handle} align="space-between" blockAlign="center">
                <Text as="p" variant="bodyMd" fontWeight={plan.handle === currentPlan.handle ? "semibold" : undefined}>
                  {plan.name} – ${plan.monthlyPrice}/month
                </Text>
                {plan.handle !== currentPlan.handle && (
                  <Button onClick={() => handleUpgrade(plan.handle)}>Upgrade</Button>
                )}
              </InlineStack>
            ))}
          </BlockStack>
        </Card>
        <Link to="/app/settings">← Back to Settings</Link>
      </BlockStack>
    </Page>
  );
}
