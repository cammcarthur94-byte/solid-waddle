import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { CampaignStatus } from "@prisma/client";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  ChoiceList,
  EmptySearchResult,
  Filters,
  IndexTable,
  InlineStack,
  Modal,
  Page,
  Pagination,
  Popover,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCurrentVariantPrices } from "../services/shopify-admin.server";
import { setCampaignVariantPrices } from "../services/shopify-campaign-prices.server";
import {
  enforceCampaignPlanLimits,
  assertPremiumFeature,
  type PremiumFeature,
  getShopifyShopId,
  getShopPlanEntitlements,
  PlanLimitError,
} from "../services/shopify-app-pricing.server";

const pageSize = 10;
const statusValues = Object.values(CampaignStatus);
const statusTone: Record<
  CampaignStatus,
  "info" | "success" | "attention" | "critical" | undefined
> = {
  Draft: undefined,
  Scheduled: "info",
  Running: "success",
  Completed: undefined,
  Cancelled: "attention",
  Failed: "critical",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const statusValue = url.searchParams.get("status") ?? "";
  const status = statusValues.includes(statusValue as CampaignStatus)
    ? (statusValue as CampaignStatus)
    : undefined;
  const selectedId = url.searchParams.get("selected");
  const requestedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop },
    update: {},
    select: { id: true },
  });

  const where = {
    shopId: shop.id,
    ...(status ? { status } : {}),
    ...(query ? { name: { contains: query, mode: "insensitive" as const } } : {}),
  };
  const totalCount = await prisma.campaign.count({ where });
  const lastPage = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(page, lastPage);
  const [campaigns, selectedCampaign, templates] = await Promise.all([
    prisma.campaign.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
        collectionTitle: true,
        _count: { select: { products: true } },
      },
    }),
    selectedId
      ? prisma.campaign.findFirst({
          where: { id: selectedId, shopId: shop.id },
          select: {
            id: true,
            name: true,
            description: true,
            status: true,
            startDate: true,
            endDate: true,
            recurrenceIntervalDays: true,
            recurrenceEndsAt: true,
            collectionTitle: true,
            products: {
              select: {
                id: true,
                shopifyProductId: true,
                shopifyVariantId: true,
                originalPrice: true,
                targetPrice: true,
                originalCompareAtPrice: true,
                targetCompareAtPrice: true,
              },
            },
          },
        })
      : Promise.resolve(null),
    prisma.campaignTemplate.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, select: { id: true, name: true } }),
  ]);

  return {
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      startDate: campaign.startDate?.toISOString() ?? null,
      endDate: campaign.endDate?.toISOString() ?? null,
      productCount: campaign._count.products,
      collectionTitle: campaign.collectionTitle,
    })),
    page: currentPage,
    pageSize,
    totalCount,
    query,
    status: status ?? "",
    templates,
    selectedCampaign: selectedCampaign
      ? {
          ...selectedCampaign,
          startDate: selectedCampaign.startDate?.toISOString() ?? null,
          endDate: selectedCampaign.endDate?.toISOString() ?? null,
          recurrenceEndsAt: selectedCampaign.recurrenceEndsAt?.toISOString() ?? null,
        products: selectedCampaign.products.map((product) => ({
          ...product,
          originalPrice: product.originalPrice.toString(),
          targetPrice: product.targetPrice.toString(),
          originalCompareAtPrice: product.originalCompareAtPrice?.toString() ?? null,
          targetCompareAtPrice: product.targetCompareAtPrice?.toString() ?? null,
        })),
      }
      : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop },
    update: {},
    select: { id: true },
  });

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const campaignId = String(formData.get("campaignId") ?? "");
  if (intent === "useTemplate") {
    const plan = await getShopPlanEntitlements(session.shop, await getShopifyShopId(admin)).then((entitlements) => entitlements.plan);
    try {
      assertPremiumFeature(plan, "campaignTemplates");
    } catch (error) {
      if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
      throw error;
    }
    const template = await prisma.campaignTemplate.findFirst({ where: { id: String(formData.get("templateId") ?? ""), shopId: shop.id } });
    if (!template || !template.config || typeof template.config !== "object") return json({ error: "Template not found or invalid." }, { status: 404 });
    const config = template.config as { name: string; description: string | null; startDate: string | null; endDate: string | null; products: Array<{ shopifyProductId: string; shopifyVariantId: string; originalPrice: string; targetPrice: string; originalCompareAtPrice: string | null; targetCompareAtPrice: string | null }> };
    if (!Array.isArray(config.products) || !config.products.length) return json({ error: "Template has no products." }, { status: 400 });
    if (config.products.some((product) => product.targetCompareAtPrice !== null)) {
      try {
        assertPremiumFeature(plan, "compareAtScheduling");
      } catch (error) {
        if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
        throw error;
      }
    }
    try {
      const created = await prisma.$transaction(async (tx) => {
        await enforceCampaignPlanLimits(tx, shop.id, plan, config.products.length);
        return tx.campaign.create({ data: { shopId: shop.id, name: `${template.name} campaign`, description: config.description, startDate: config.startDate ? new Date(config.startDate) : null, endDate: config.endDate ? new Date(config.endDate) : null, status: CampaignStatus.Draft, products: { create: config.products } }, select: { id: true } });
      });
      return json({ success: "Campaign created from template.", campaignId: created.id });
    } catch (error) {
      if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
      throw error;
    }
  }

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id },
    include: { products: true },
  });
  if (!campaign) {
    return json({ error: "Campaign not found." }, { status: 404 });
  }

  const requirePremium = async (feature: PremiumFeature) => {
    const entitlements = await getShopPlanEntitlements(session.shop, await getShopifyShopId(admin));
    assertPremiumFeature(entitlements.plan, feature);
    return entitlements.plan;
  };

  if (intent === "schedule") {
    if (campaign.status !== CampaignStatus.Draft) {
      return json({ error: "Only draft campaigns can be scheduled." }, { status: 400 });
    }
    if (!campaign.startDate || !campaign.endDate || campaign.products.length === 0) {
      return json({ error: "A campaign needs start and end dates and at least one variant." }, { status: 400 });
    }

    const startDate = campaign.startDate;
    const endDate = campaign.endDate;
    const shopifyShopId = await getShopifyShopId(admin);
    const entitlements = await getShopPlanEntitlements(session.shop, shopifyShopId);
    if (campaign.collectionId) {
      try {
        assertPremiumFeature(entitlements.plan, "collectionCampaigns");
      } catch (error) {
        if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
        throw error;
      }
    }
    if (campaign.recurrenceIntervalDays) {
      try {
        assertPremiumFeature(entitlements.plan, "recurringCampaigns");
      } catch (error) {
        if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
        throw error;
      }
    }
    if (campaign.products.some((product) => product.targetCompareAtPrice !== null)) {
      try {
        assertPremiumFeature(entitlements.plan, "compareAtScheduling");
      } catch (error) {
        if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
        throw error;
      }
    }
    let scheduled: boolean;
    try {
      scheduled = await prisma.$transaction(async (tx) => {
        await enforceCampaignPlanLimits(
          tx,
          shop.id,
          entitlements.plan,
          campaign.products.length,
          {
            active: true,
            lock: true,
            enforceCampaignLimit: true,
            ignoreCampaignId: campaign.id,
          },
        );
        const result = await tx.campaign.updateMany({
          where: {
            id: campaign.id,
            shopId: shop.id,
            status: CampaignStatus.Draft,
            startDate,
            endDate,
          },
          data: { status: CampaignStatus.Scheduled },
        });
        if (!result.count) return false;
        await tx.activityLog.create({
          data: {
            shopId: shop.id,
            campaignId: campaign.id,
            action: "CAMPAIGN_SCHEDULED",
            message: `Scheduled campaign “${campaign.name}”.`,
            metadata: {
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString(),
            },
          },
        });
        return true;
      });
    } catch (error) {
      if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
      throw error;
    }
    return scheduled
      ? json({ success: "Campaign scheduled." })
      : json({ error: "Campaign changed before it could be scheduled. Refresh and try again." }, { status: 409 });
  }

  if (intent === "cancel") {
    if (
      campaign.status !== CampaignStatus.Scheduled &&
      campaign.status !== CampaignStatus.Running
    ) {
      return json(
        { error: "Only scheduled or running campaigns can be cancelled." },
        { status: 400 },
      );
    }
    const cancelled = await prisma.$transaction(async (tx) => {
      const result = await tx.campaign.updateMany({
        where: {
          id: campaign.id,
          shopId: shop.id,
          status: campaign.status,
          processingToken: null,
        },
        data: {
          status: CampaignStatus.Cancelled,
          processingLeaseExpiresAt: null,
        },
      });
      if (!result.count) return false;
      await tx.activityLog.create({
        data: {
          shopId: shop.id,
          campaignId: campaign.id,
          action: "CAMPAIGN_CANCELLED",
          message: `Cancelled campaign “${campaign.name}”.`,
        },
      });
      return true;
    });
    return cancelled
      ? json({ success: "Campaign cancelled." })
      : json({ error: "Campaign is being processed or has changed; refresh and try again." }, { status: 409 });
  }

  if (intent === "delete") {
    const deleted = await prisma.campaign.deleteMany({
      where: { id: campaign.id, shopId: shop.id, processingToken: null },
    });
    return deleted.count
      ? json({ success: "Campaign deleted." })
      : json({ error: "Campaign is being processed or has changed; refresh and try again." }, { status: 409 });
  }

  if (intent === "saveTemplate") {
    try {
      await requirePremium("campaignTemplates");
    } catch (error) {
      if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
      throw error;
    }
    const templateName = String(formData.get("templateName") ?? "").trim();
    if (!templateName) return json({ error: "Enter a template name." }, { status: 400 });
    if (campaign.products.some((product) => product.targetCompareAtPrice !== null)) {
      try {
        await requirePremium("compareAtScheduling");
      } catch (error) {
        if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
        throw error;
      }
    }
    await prisma.campaignTemplate.create({ data: { shopId: shop.id, name: templateName, description: campaign.description, config: { name: campaign.name, description: campaign.description, startDate: campaign.startDate?.toISOString() ?? null, endDate: campaign.endDate?.toISOString() ?? null, products: campaign.products.map((product) => ({ shopifyProductId: product.shopifyProductId, shopifyVariantId: product.shopifyVariantId, originalPrice: product.originalPrice.toString(), targetPrice: product.targetPrice.toString(), originalCompareAtPrice: product.originalCompareAtPrice?.toString() ?? null, targetCompareAtPrice: product.targetCompareAtPrice?.toString() ?? null })) } } });
    return json({ success: "Campaign template saved." });
  }

  if (intent === "rollback") {
    try {
      await requirePremium("oneClickRollback");
    } catch (error) {
      if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
      throw error;
    }
    if (campaign.status !== CampaignStatus.Running || campaign.processingToken) {
      return json({ error: "Only a running campaign that is not being processed can be rolled back." }, { status: 409 });
    }
    const rollbackToken = `rollback:${randomUUID()}`;
    const claimed = await prisma.campaign.updateMany({ where: { id: campaign.id, shopId: shop.id, status: CampaignStatus.Running, processingToken: null }, data: { processingToken: rollbackToken, processingLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000) } });
    if (!claimed.count) return json({ error: "Campaign is being processed; refresh and try again." }, { status: 409 });
    let current;
    try {
      current = await getCurrentVariantPrices(admin, campaign.products.map((product) => product.shopifyVariantId));
    } catch (error) {
      await prisma.campaign.updateMany({ where: { id: campaign.id, processingToken: rollbackToken }, data: { processingToken: null, processingLeaseExpiresAt: null } });
      throw error;
    }
    const byId = new Map(current.map((variant) => [variant.id, variant]));
    const safeProducts = campaign.products.filter((product) => {
      const live = byId.get(product.shopifyVariantId);
      const priceMatches = live && Math.round(Number(live.price) * 100) === Math.round(Number(product.targetPrice) * 100);
      const compareAtMatches = product.targetCompareAtPrice === null || (live && live.compareAtPrice !== null && Math.round(Number(live.compareAtPrice) * 100) === Math.round(Number(product.targetCompareAtPrice) * 100));
      return priceMatches && compareAtMatches;
    });
    if (!safeProducts.length) {
      await prisma.campaign.updateMany({ where: { id: campaign.id, processingToken: rollbackToken }, data: { processingToken: null, processingLeaseExpiresAt: null } });
      return json({ error: "No variants still match this campaign's scheduled prices; merchant changes were preserved." }, { status: 409 });
    }
    try {
      await setCampaignVariantPrices(admin, safeProducts, (product) => product.originalPrice.toFixed(2), (product) => product.targetCompareAtPrice === null ? undefined : product.originalCompareAtPrice === null ? null : product.originalCompareAtPrice.toFixed(2));
    } catch (error) {
      await prisma.campaign.updateMany({ where: { id: campaign.id, processingToken: rollbackToken }, data: { processingToken: null, processingLeaseExpiresAt: null } });
      throw error;
    }
    try {
      await prisma.$transaction(async (tx) => {
        const result = await tx.campaign.updateMany({ where: { id: campaign.id, shopId: shop.id, status: CampaignStatus.Running, processingToken: rollbackToken }, data: { status: CampaignStatus.Cancelled, processingToken: null, processingLeaseExpiresAt: null } });
      if (!result.count) throw new Error("Campaign changed while rollback was in progress.");
        await tx.activityLog.create({ data: { shopId: shop.id, campaignId: campaign.id, action: "CAMPAIGN_ROLLED_BACK", message: `Rolled back ${safeProducts.length} variant(s) for campaign “${campaign.name}”.`, metadata: { restoredCount: safeProducts.length, preservedMerchantChanges: campaign.products.length - safeProducts.length } } });
      });
    } catch (error) {
      await prisma.campaign.updateMany({ where: { id: campaign.id, processingToken: rollbackToken }, data: { processingToken: null, processingLeaseExpiresAt: null } });
      throw error;
    }
    return json({ success: `Rolled back ${safeProducts.length} variants.` });
  }

  if (intent === "bulkDuplicate") {
    let plan;
    try {
      plan = await requirePremium("bulkDuplicateCampaigns");
    } catch (error) {
      if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
      throw error;
    }
    const ids = Array.from(new Set(formData.getAll("campaignIds").map(String))).slice(0, 25);
    if (!ids.length) return json({ error: "Select campaigns to duplicate." }, { status: 400 });
    const sources = await prisma.campaign.findMany({ where: { shopId: shop.id, id: { in: ids } }, include: { products: true } });
    if (sources.length !== ids.length) return json({ error: "One or more selected campaigns were not found." }, { status: 404 });
    try {
      const copies = await prisma.$transaction(async (tx) => {
        for (const source of sources) await enforceCampaignPlanLimits(tx, shop.id, plan, source.products.length);
        return Promise.all(sources.map((source) => tx.campaign.create({ data: { shopId: shop.id, name: `${source.name} (copy)`, description: source.description, startDate: source.startDate, endDate: source.endDate, recurrenceIntervalDays: source.recurrenceIntervalDays, recurrenceEndsAt: source.recurrenceEndsAt, collectionId: source.collectionId, collectionTitle: source.collectionTitle, status: CampaignStatus.Draft, products: { create: source.products.map((product) => ({ shopifyProductId: product.shopifyProductId, shopifyVariantId: product.shopifyVariantId, originalPrice: product.originalPrice, targetPrice: product.targetPrice, originalCompareAtPrice: product.originalCompareAtPrice, targetCompareAtPrice: product.targetCompareAtPrice })) } }, select: { id: true } })));
      });
      return json({ success: `Duplicated ${copies.length} campaigns.` });
    } catch (error) {
      if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
      throw error;
    }
  }

  if (intent === "duplicate") {
    const plan = (await getShopPlanEntitlements(
      session.shop,
      await getShopifyShopId(admin),
    )).plan;
    let copy;
    try {
      copy = await prisma.$transaction(async (tx) => {
        await enforceCampaignPlanLimits(tx, shop.id, plan, campaign.products.length);
        return tx.campaign.create({
          data: {
            shopId: shop.id,
            name: `${campaign.name} (copy)`,
            description: campaign.description,
            recurrenceIntervalDays: campaign.recurrenceIntervalDays,
            recurrenceEndsAt: campaign.recurrenceEndsAt,
            collectionId: campaign.collectionId,
            collectionTitle: campaign.collectionTitle,
            startDate: campaign.startDate,
            endDate: campaign.endDate,
            status: CampaignStatus.Draft,
            products: {
              create: campaign.products.map((product) => ({
                shopifyProductId: product.shopifyProductId,
                shopifyVariantId: product.shopifyVariantId,
                originalPrice: product.originalPrice,
                targetPrice: product.targetPrice,
                originalCompareAtPrice: product.originalCompareAtPrice,
                targetCompareAtPrice: product.targetCompareAtPrice,
              })),
            },
          },
          select: { id: true },
        });
      });
    } catch (error) {
      if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
      throw error;
    }
    return json({ success: "Campaign duplicated.", campaignId: copy.id });
  }

  if (intent === "edit") {
    const name = String(formData.get("name") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    const startDateValue = String(formData.get("startDate") ?? "");
    const endDateValue = String(formData.get("endDate") ?? "");
    if (!name) {
      return json({ error: "Campaign name is required." }, { status: 400 });
    }
    if (campaign.status !== CampaignStatus.Draft) {
      return json({ error: "Only draft campaigns can be edited." }, { status: 400 });
    }
    const updated = await prisma.campaign.updateMany({
      where: {
        id: campaign.id,
        shopId: shop.id,
        status: CampaignStatus.Draft,
      },
      data: {
        name,
        ...(formData.has("description") ? { description: description || null } : {}),
        ...(startDateValue ? { startDate: new Date(`${startDateValue}T00:00:00.000Z`) } : {}),
        ...(endDateValue ? { endDate: new Date(`${endDateValue}T23:59:59.999Z`) } : {}),
      },
    });
    return updated.count
      ? json({ success: "Campaign updated.", campaignId: campaign.id })
      : json({ error: "Campaign changed before it could be updated. Refresh and try again." }, { status: 409 });
  }

  return json({ error: "Unknown campaign action." }, { status: 400 });
};

function formatDate(date: string | null) {
  return date
    ? new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(new Date(date))
    : "—";
}

export default function Campaigns() {
  const {
    campaigns,
    page,
    pageSize: limit,
    totalCount,
    query,
    status,
    selectedCampaign,
    templates,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const [queryValue, setQueryValue] = useState(query);
  const [statusValue, setStatusValue] = useState(status);
  const [filterOpen, setFilterOpen] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState("");

  useEffect(() => setQueryValue(query), [query]);
  useEffect(() => setStatusValue(status), [status]);

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      next.delete("page");
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    if (queryValue === query) return;
    const timer = window.setTimeout(() => updateParams({ q: queryValue }), 250);
    return () => window.clearTimeout(timer);
  }, [query, queryValue, updateParams]);

  const appliedFilters = useMemo(
    () =>
      statusValue
        ? [
            {
              key: "status",
              label: `Status: ${statusValue}`,
              onRemove: () => {
                setStatusValue("");
                updateParams({ status: "" });
              },
            },
          ]
        : [],
    [statusValue, updateParams],
  );

  useEffect(() => {
    if (fetcher.data && "success" in fetcher.data) {
      setEditingCampaignId(null);
      window.shopify?.toast?.show(fetcher.data.success);
    } else if (fetcher.data && "error" in fetcher.data) {
      window.shopify?.toast?.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data]);

  const rowMarkup = campaigns.map((campaign, index) => (
    <IndexTable.Row id={campaign.id} key={campaign.id} position={index}>
      <IndexTable.Cell>
        <input aria-label={`Select ${campaign.name} for bulk duplicate`} type="checkbox" checked={selectedCampaignIds.includes(campaign.id)} onChange={(event) => setSelectedCampaignIds((current) => event.target.checked ? [...current, campaign.id] : current.filter((id) => id !== campaign.id))} />
        {editingCampaignId === campaign.id ? (
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <TextField
              label="Campaign name"
              labelHidden
              value={editingName}
              onChange={setEditingName}
              autoComplete="off"
            />
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="edit" />
              <input type="hidden" name="campaignId" value={campaign.id} />
              <input type="hidden" name="name" value={editingName} />
              <Button
                submit
                size="slim"
                variant="primary"
                loading={fetcher.state !== "idle"}
              >
                Save
              </Button>
            </fetcher.Form>
            <Button size="slim" onClick={() => setEditingCampaignId(null)}>
              Cancel edit
            </Button>
          </InlineStack>
        ) : (
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {campaign.name}
          </Text>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>          <Badge tone={statusTone[campaign.status]}>{campaign.status}</Badge>
          {campaign.collectionTitle ? ` · ${campaign.collectionTitle}` : ""}
      </IndexTable.Cell>
      <IndexTable.Cell>{formatDate(campaign.startDate)}</IndexTable.Cell>
      <IndexTable.Cell>{formatDate(campaign.endDate)}</IndexTable.Cell>
      <IndexTable.Cell>{campaign.productCount.toLocaleString()}</IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="100" wrap={false}>
          <Button
            size="slim"
            onClick={() =>
              setSearchParams((current) => {
                current.set("selected", campaign.id);
                return current;
              })
            }
          >
            View
          </Button>
          <Button
            size="slim"
            onClick={() => {
              setEditingName(campaign.name);
              setEditingCampaignId(campaign.id);
            }}
          >
            Edit
          </Button>
          {campaign.status === CampaignStatus.Draft && (
            <fetcher.Form method="post">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <input type="hidden" name="intent" value="schedule" />
              <Button size="slim" submit variant="primary" loading={fetcher.state !== "idle"}>
                Schedule
              </Button>
            </fetcher.Form>
          )}
          <fetcher.Form method="post">
            <input type="hidden" name="campaignId" value={campaign.id} />
            <input type="hidden" name="intent" value="saveTemplate" />
            <input type="hidden" name="templateName" value={`${campaign.name} template`} />
            <Button size="slim" submit loading={fetcher.state !== "idle"}>Save template — Pro</Button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="campaignId" value={campaign.id} />
            <input type="hidden" name="intent" value="duplicate" />
            <Button size="slim" submit loading={fetcher.state !== "idle"}>
              Duplicate
            </Button>
          </fetcher.Form>
          {campaign.status === CampaignStatus.Running && (
            <fetcher.Form method="post">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <input type="hidden" name="intent" value="rollback" />
              <Button size="slim" submit variant="primary" loading={fetcher.state !== "idle"}>Rollback — Pro</Button>
            </fetcher.Form>
          )}
          {(campaign.status === CampaignStatus.Scheduled ||
            campaign.status === CampaignStatus.Running) && (
            <fetcher.Form method="post">
              <input type="hidden" name="campaignId" value={campaign.id} />
              <input type="hidden" name="intent" value="cancel" />
              <Button size="slim" submit loading={fetcher.state !== "idle"}>
                Cancel
              </Button>
            </fetcher.Form>
          )}
          <fetcher.Form
            method="post"
            onSubmit={(event) => {
              if (
                !window.confirm(
                  `Delete “${campaign.name}”? This cannot be undone.`,
                )
              ) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="campaignId" value={campaign.id} />
            <input type="hidden" name="intent" value="delete" />
            <Button size="slim" submit tone="critical" loading={fetcher.state !== "idle"}>
              Delete
            </Button>
          </fetcher.Form>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  const statusFilter = (
    <ChoiceList
      title="Campaign status"
      titleHidden
      choices={statusValues.map((value) => ({ label: value, value }))}
      selected={statusValue ? [statusValue] : []}
      onChange={(selected) => {
        const value = selected[0] ?? "";
        setStatusValue(value);
        updateParams({ status: value });
      }}
    />
  );

  const closeDetails = () =>
    setSearchParams((current) => {
      current.delete("selected");
      return current;
    });  return (
    <Page
      title="Campaigns"
      primaryAction={{ content: "Create campaign", url: "/app/campaigns/new" }}
    >
      <TitleBar title="Campaigns" />
      <Card padding="0">
        <BlockStack gap="0">
          {templates.length > 0 && <InlineStack align="end" gap="200" blockAlign="center">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="useTemplate" />
              <select aria-label="Campaign template" name="templateId" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                <option value="">Choose template</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
              <Button submit disabled={!templateId} loading={fetcher.state !== "idle"}>Create from template — Pro</Button>
            </fetcher.Form>
            <Text as="span" variant="bodySm">{selectedCampaignIds.length} selected</Text>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="bulkDuplicate" />
              {selectedCampaignIds.map((id) => <input key={id} type="hidden" name="campaignIds" value={id} />)}
              <Button submit disabled={!selectedCampaignIds.length} loading={fetcher.state !== "idle"}>Bulk duplicate — Pro</Button>
            </fetcher.Form>
          </InlineStack>}
          <Filters
            queryValue={queryValue}
            queryPlaceholder="Search campaigns"
            filters={[]}
            appliedFilters={appliedFilters}
            onQueryChange={setQueryValue}
            onQueryClear={() => {
              setQueryValue("");
              updateParams({ q: "" });
            }}
            onClearAll={() => {
              setQueryValue("");
              setStatusValue("");
              setSearchParams({});
            }}
          >
            <Popover
              active={filterOpen}
              activator={
                <Button
                  onClick={() => setFilterOpen((open) => !open)}
                  disclosure
                >
                  Filter status
                </Button>
              }
              onClose={() => setFilterOpen(false)}
            >
              <div style={{ padding: "1rem", minWidth: "220px" }}>
                {statusFilter}
              </div>
            </Popover>
          </Filters>
          {fetcher.data && "error" in fetcher.data && (
            <div style={{ padding: "0.75rem 1rem" }}>
              <Text as="p" tone="critical">
                {fetcher.data.error}
              </Text>
            </div>
          )}
          <IndexTable
            resourceName={{ singular: "campaign", plural: "campaigns" }}
            itemCount={totalCount}
            headings={[
              { title: "Campaign Name" },
              { title: "Status" },
              { title: "Start Date" },
              { title: "End Date" },
              { title: "Product Count", alignment: "end" },
              { title: "Actions" },
            ]}
            emptyState={
              <EmptySearchResult
                title={query || status ? "No campaigns found" : "No campaigns yet"}
                description={
                  query || status
                    ? "Try adjusting your search or filters."
                    : "Create a campaign to get started."
                }
                withIllustration={false}
              />
            }
          >
            {rowMarkup}
          </IndexTable>
          <div
            style={{
              padding: "1rem",
              borderTop: "1px solid var(--p-color-border)",
            }}
          >
            <Pagination
              type="table"
              hasPrevious={page > 1}
              hasNext={page * limit < totalCount}
              onPrevious={() =>
                setSearchParams((current) => {
                  current.set("page", String(page - 1));
                  return current;
                })
              }
              onNext={() =>
                setSearchParams((current) => {
                  current.set("page", String(page + 1));
                  return current;
                })
              }
              label={
                totalCount
                  ? `${(page - 1) * limit + 1}–${Math.min(page * limit, totalCount)} of ${totalCount} campaigns`
                  : "0 campaigns"
              }
            />
          </div>
        </BlockStack>
      </Card>
      <Modal
        open={Boolean(selectedCampaign)}
        onClose={closeDetails}
        title={selectedCampaign?.name ?? "Campaign details"}
        primaryAction={{
          content: "Edit campaign name",
          onAction: () => {
            if (!selectedCampaign) return;
            setEditingName(selectedCampaign.name);
            setEditingCampaignId(selectedCampaign.id);
            closeDetails();
          },
        }}
        secondaryActions={[{ content: "Close", onAction: closeDetails }]}
      >
        {selectedCampaign && (
          <Modal.Section>
            <BlockStack gap="400">
              <InlineStack gap="300" blockAlign="center">
                <Text as="span" variant="bodyMd">
                  Status
                </Text>
                <Badge tone={statusTone[selectedCampaign.status]}>
                  {selectedCampaign.status}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd">
                Start date: {formatDate(selectedCampaign.startDate)}
              </Text>
              <Text as="p" variant="bodyMd">
                End date: {formatDate(selectedCampaign.endDate)}
              </Text>
              <Text as="p" variant="bodyMd">
                {selectedCampaign.description || "No description provided."}
              </Text>
              {selectedCampaign.collectionTitle && <Text as="p" variant="bodyMd">Collection: {selectedCampaign.collectionTitle}</Text>}
              {selectedCampaign.recurrenceIntervalDays && <Text as="p" variant="bodyMd">Repeats every {selectedCampaign.recurrenceIntervalDays} days through {formatDate(selectedCampaign.recurrenceEndsAt)}</Text>}
              <Text as="h3" variant="headingMd">
                Products ({selectedCampaign.products.length})
              </Text>
              {selectedCampaign.products.length ? (
                selectedCampaign.products.map((product) => (
                  <BlockStack key={product.id} gap="100">
                    <Text as="p" variant="bodyMd">
                      {product.shopifyProductId}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Variant {product.shopifyVariantId} · {product.originalPrice} → {product.targetPrice}{product.targetCompareAtPrice !== null ? ` · Compare-at ${product.originalCompareAtPrice ?? "none"} → ${product.targetCompareAtPrice}` : ""}
                    </Text>
                  </BlockStack>
                ))
              ) : (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No products in this campaign.
                </Text>
              )}
            </BlockStack>
          </Modal.Section>
        )}
      </Modal>
    </Page>
  );
}

declare global {
  interface Window {
    shopify?: {
      toast?: {
        show(message: string, options?: object): void;
      };
    };
  }
}
