import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link as RemixLink, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const activityLimit = 6;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });

  if (!shop) {
    return {
      metrics: { active: 0, scheduled: 0, completed: 0, productsScheduled: 0 },
      activity: [],
    };
  }

  const [active, scheduled, completed, productsScheduled, activity] =
    await Promise.all([
      prisma.campaign.count({ where: { shopId: shop.id, status: "Running" } }),
      prisma.campaign.count({ where: { shopId: shop.id, status: "Scheduled" } }),
      prisma.campaign.count({ where: { shopId: shop.id, status: "Completed" } }),
      prisma.campaignProduct.count({
        where: { campaign: { shopId: shop.id, status: "Scheduled" } },
      }),
      prisma.activityLog.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        take: activityLimit,
        select: {
          id: true,
          action: true,
          message: true,
          createdAt: true,
          campaign: { select: { name: true } },
        },
      }),
    ]);

  return {
    metrics: { active, scheduled, completed, productsScheduled },
    activity: activity.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
  };
};

function formatRelativeTime(date: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function Dashboard() {
  const { metrics, activity } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Dashboard" />
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <BlockStack gap="100">
            <Text as="h1" variant="headingLg">
              PricePilot overview
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Monitor your pricing campaigns and recent store activity.
            </Text>
          </BlockStack>
          <Button variant="primary" url="/app/campaigns">
            Create campaign
          </Button>
        </InlineStack>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <MetricCard title="Active campaigns" value={metrics.active} />
          <MetricCard title="Scheduled campaigns" value={metrics.scheduled} />
          <MetricCard title="Completed campaigns" value={metrics.completed} />
          <MetricCard
            title="Products scheduled"
            value={metrics.productsScheduled}
          />
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Recent activity
                  </Text>
                  <Button variant="plain" url="/app/activity-logs">
                    View activity logs
                  </Button>
                </InlineStack>
                {activity.length > 0 ? (
                  <BlockStack gap="0">
                    {activity.map((item) => (
                      <Box
                        key={item.id}
                        paddingBlock="300"
                        borderBlockStartWidth="025"
                        borderColor="border"
                      >
                        <InlineStack
                          align="space-between"
                          blockAlign="start"
                          gap="300"
                          wrap
                        >
                          <BlockStack gap="100">
                            <Text
                              as="p"
                              variant="bodyMd"
                              fontWeight="medium"
                            >
                              {item.message}
                            </Text>
                            <InlineStack gap="200" blockAlign="center">
                              <Badge>
                                {item.action.replaceAll("_", " ")}
                              </Badge>
                              {item.campaign && (
                                <Text
                                  as="span"
                                  variant="bodySm"
                                  tone="subdued"
                                >
                                  {item.campaign.name}
                                </Text>
                              )}
                            </InlineStack>
                          </BlockStack>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {formatRelativeTime(item.createdAt)}
                          </Text>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                ) : (
                  <EmptyState
                    heading="No activity yet"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>Campaign updates and pricing changes will show up here.</p>
                  </EmptyState>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Quick actions
                </Text>
                <BlockStack gap="200">
                  <Button fullWidth variant="primary" url="/app/campaigns">
                    Create campaign
                  </Button>
                  <Button fullWidth url="/app/campaigns">
                    View campaigns
                  </Button>
                  <Button fullWidth url="/app/activity-logs">
                    Activity logs
                  </Button>
                </BlockStack>
              </BlockStack>
            </Card>
            <Box paddingBlockStart="400">
              <Text as="p" variant="bodySm" tone="subdued">
                Need help managing your store? Visit{" "}
                <RemixLink to="/app/settings">PricePilot settings</RemixLink>.
              </Text>
            </Box>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function MetricCard({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="bodyMd" tone="subdued">
          {title}
        </Text>
        <Text as="p" variant="heading2xl">
          {value.toLocaleString()}
        </Text>
      </BlockStack>
    </Card>
  );
}
