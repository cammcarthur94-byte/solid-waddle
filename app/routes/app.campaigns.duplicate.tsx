// File: c:/Users/Cam/Desktop/PricePilot/app/routes/app.campaigns.duplicate.tsx
import { json, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { Button, Card, BlockStack, Page, Text, Banner } from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });
  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id },
    select: { id: true, name: true },
    orderBy: { createdAt: "desc" },
  });
  return json({ campaigns });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });
  const form = await request.formData();
  const ids = JSON.parse(String(form.get("ids")));
  if (!Array.isArray(ids) || ids.length === 0) {
    return json({ error: "No campaigns selected for duplication." }, { status: 400 });
  }
  try {
    await prisma.$transaction(async (tx) => {
      for (const id of ids) {
        const source = await tx.campaign.findUnique({
          where: { id },
          include: { products: true },
        });
        if (!source) continue;
        const copy = await tx.campaign.create({
          data: {
            shopId: shop.id,
            name: `${source.name} (Copy)`,
            description: source.description,
            startDate: source.startDate,
            endDate: source.endDate,
            recurrenceIntervalDays: source.recurrenceIntervalDays,
            recurrenceEndsAt: source.recurrenceEndsAt,
            collectionId: source.collectionId,
            collectionTitle: source.collectionTitle,
            status: source.status,
            products: {
              create: source.products.map((p) => ({
                shopifyProductId: p.shopifyProductId,
                shopifyVariantId: p.shopifyVariantId,
                originalPrice: p.originalPrice,
                targetPrice: p.targetPrice,
                originalCompareAtPrice: p.originalCompareAtPrice,
                targetCompareAtPrice: p.targetCompareAtPrice,
              })),
            },
          },
        });
        await tx.activityLog.create({
          data: {
            shopId: shop.id,
            campaignId: copy.id,
            action: "CAMPAIGN_DUPLICATED",
            message: `Duplicated campaign “${source.name}”.`,
            metadata: { sourceCampaignId: source.id },
          },
        });
      }
    });
    return redirect("/app/campaigns");
  } catch (e) {
    console.error(e);
    return json({ error: "Failed to duplicate campaigns." }, { status: 500 });
  }
};

export default function DuplicateCampaigns() {
  const { campaigns } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const [selected, setSelected] = React.useState<string[]>([]);

  const toggle = (id: string) => {
    setSelected(prev => (prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]));
  };

  const submit = () => {
    fetcher.submit({ ids: JSON.stringify(selected) }, { method: "post" });
  };

  React.useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !(fetcher.data as any).error) {
      navigate("/app/campaigns");
    }
  }, [fetcher]);

  return (
    <Page title="Duplicate campaigns">
      <BlockStack gap="400">
        {fetcher.data?.error && <Banner tone="critical">{(fetcher.data as any).error}</Banner>}
        <Card>
          <BlockStack gap="300">
            {campaigns.map((c: any) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center" }}>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                <Text variant="bodyMd" as="span" style={{ marginLeft: 8 }}>{c.name}</Text>
              </label>
            ))}
          </BlockStack>
        </Card>
        <Button disabled={selected.length === 0} onClick={submit} loading={fetcher.state !== "idle"}>
          Duplicate selected
        </Button>
      </BlockStack>
    </Page>
  );
}
