import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { CampaignStatus } from "@prisma/client";
import type { Collection, Product, ProductVariant } from "@shopify/app-bridge-types";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  ChoiceList,
  Divider,
  FormLayout,
  InlineGrid,
  InlineStack,
  Page,
  ProgressBar,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getCurrentVariantPrices } from "../services/shopify-admin.server";
import { getCollectionCampaignVariants } from "../services/shopify-premium-campaigns.server";
import {
  enforceCampaignPlanLimits,
  getShopifyShopId,
  getShopPlanEntitlements,
  PlanLimitError,
  assertPremiumFeature,
  type PremiumFeature,
} from "../services/shopify-app-pricing.server";

const wizardSteps = [
  "Campaign details",
  "Product selection",
  "Pricing configuration",
  "Review and confirm",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(`#graphql
    query CampaignStoreCurrency {
      shop { currencyCode }
    }
  `);
  const result = await response.json();
  if ((result as { errors?: unknown[] }).errors?.length) {
    throw new Response("Unable to load store currency.", { status: 502 });
  }
  return { currencyCode: result.data?.shop?.currencyCode ?? "USD" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await prisma.shop.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop },
    update: {},
    select: { id: true },
  });

  const formData = await request.formData();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const startDateValue = String(formData.get("startDate") ?? "");
  const endDateValue = String(formData.get("endDate") ?? "");
  const pricingType = String(formData.get("pricingType") ?? "");
  const pricingValue = Number(formData.get("pricingValue"));
  const productsValue = String(formData.get("products") ?? "[]");
  const recurrenceIntervalDaysValue = String(formData.get("recurrenceIntervalDays") ?? "");
  const recurrenceEndsAtValue = String(formData.get("recurrenceEndsAt") ?? "");
  const collectionIdValue = String(formData.get("collectionId") ?? "");
  const compareAtPricingValue = String(formData.get("compareAtPricingValue") ?? "");

  if (!name) return json({ error: "Enter a campaign name." }, { status: 400 });
  if (!startDateValue || !endDateValue) {
    return json({ error: "Enter both campaign dates." }, { status: 400 });
  }
  const startDate = new Date(`${startDateValue}T00:00:00.000Z`);
  const endDate = new Date(`${endDateValue}T23:59:59.999Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDateValue) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(endDateValue) ||
    !Number.isFinite(startDate.getTime()) ||
    !Number.isFinite(endDate.getTime()) ||
    startDate.toISOString().slice(0, 10) !== startDateValue ||
    endDate.toISOString().slice(0, 10) !== endDateValue ||
    endDate < startDate
  ) {
    return json({ error: "The end date must be on or after the start date." }, { status: 400 });
  }
  if (!["percentageDiscount", "percentageIncrease", "fixedPrice"].includes(pricingType)) {
    return json({ error: "Choose a pricing configuration." }, { status: 400 });
  }
  if (
    !Number.isFinite(pricingValue) ||
    pricingValue < 0 ||
    (pricingType !== "fixedPrice" && (pricingValue === 0 || pricingValue > 100))
  ) {
    return json({ error: "Enter a valid pricing value." }, { status: 400 });
  }

  let selectedProducts: Array<{ productId: string; variantId: string }>;
  try {
    const parsed: unknown = JSON.parse(productsValue);
    if (!Array.isArray(parsed)) throw new Error("Invalid product list");
    selectedProducts = parsed.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid product");
      const item = entry as Record<string, unknown>;
      if (
        typeof item.productId !== "string" ||
        !item.productId.startsWith("gid://shopify/Product/") ||
        typeof item.variantId !== "string" ||
        !item.variantId.startsWith("gid://shopify/ProductVariant/")
      ) {
        throw new Error("Invalid product data");
      }
      return { productId: item.productId, variantId: item.variantId };
    });
  } catch {
    return json({ error: "Selected product data is invalid. Please select your products again." }, { status: 400 });
  }

  const uniqueProducts = Array.from(
    new Map(selectedProducts.map((product) => [product.variantId, product])).values(),
  );
  if (!collectionIdValue && uniqueProducts.length === 0) {
    return json({ error: "Select at least one product or variant." }, { status: 400 });
  }
  const shopifyShopId = await getShopifyShopId(admin);
  const entitlements = await getShopPlanEntitlements(session.shop, shopifyShopId);
  const premiumFeatures: PremiumFeature[] = [];
  if (recurrenceIntervalDaysValue) premiumFeatures.push("recurringCampaigns");
  if (collectionIdValue) premiumFeatures.push("collectionCampaigns");
  if (compareAtPricingValue) premiumFeatures.push("compareAtScheduling");
  try {
    for (const feature of premiumFeatures) assertPremiumFeature(entitlements.plan, feature);
  } catch (error) {
    if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
    throw error;
  }

  if (recurrenceIntervalDaysValue) {
    const interval = Number(recurrenceIntervalDaysValue);
    if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
      return json({ error: "Recurrence interval must be between 1 and 365 days." }, { status: 400 });
    }
    if (!recurrenceEndsAtValue) return json({ error: "Choose when the recurring campaign should end." }, { status: 400 });
  }
  const compareAtPrice = compareAtPricingValue === "" ? null : Number(compareAtPricingValue);
  if (compareAtPrice !== null && (!Number.isFinite(compareAtPrice) || compareAtPrice < 0)) {
    return json({ error: "Enter a valid compare-at price." }, { status: 400 });
  }
  const recurrenceEndsAt = recurrenceEndsAtValue ? new Date(`${recurrenceEndsAtValue}T23:59:59.999Z`) : null;
  if (recurrenceEndsAt && (!/^\\d{4}-\\d{2}-\\d{2}$/.test(recurrenceEndsAtValue) || !Number.isFinite(recurrenceEndsAt.getTime()) || recurrenceEndsAt.toISOString().slice(0, 10) !== recurrenceEndsAtValue || recurrenceEndsAt < endDate)) {
    return json({ error: "Recurrence end must be on or after the campaign end date." }, { status: 400 });
  }

  let productsToCreate = uniqueProducts;
  let collectionTitle: string | null = null;
  if (collectionIdValue) {
    if (!/^gid:\/\/shopify\/Collection\/[A-Za-z0-9_-]+$/.test(collectionIdValue)) {
      return json({ error: "Selected collection is invalid." }, { status: 400 });
    }
    try {
      const collection = await getCollectionCampaignVariants(admin, collectionIdValue);
      collectionTitle = collection.title;
      productsToCreate = collection.variants.map(({ productId, variantId }) => ({ productId, variantId }));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unable to load collection." }, { status: 400 });
    }
    if (productsToCreate.length === 0) return json({ error: "The selected collection has no variants." }, { status: 400 });
  }

  let currentPrices: Awaited<ReturnType<typeof getCurrentVariantPrices>>;
  try {
    currentPrices = await getCurrentVariantPrices(
      admin,
      productsToCreate.map((product) => product.variantId),
    );
  } catch {
    return json({ error: "Unable to verify selected products with Shopify. Check product access and retry." }, { status: 502 });
  }

  const shopifyProducts: Array<{ productId: string; variantId: string; price: number; compareAtPrice: number | null }> = [];
  for (const node of currentPrices) {
    const price = Number(node.price);
    const verifiedProduct = productsToCreate.find((product) => product.variantId === node.id);
    if (!verifiedProduct || verifiedProduct.productId !== node.product.id || !Number.isFinite(price) || price < 0) {
      return json({ error: "A selected variant could not be verified. Please select your products again." }, { status: 400 });
    }
    const compareAtPrice = node.compareAtPrice === null ? null : Number(node.compareAtPrice);
    if (compareAtPrice !== null && (!Number.isFinite(compareAtPrice) || compareAtPrice < 0)) {
      return json({ error: "A selected compare-at price could not be verified." }, { status: 400 });
    }
    shopifyProducts.push({ productId: node.product.id, variantId: node.id, price, compareAtPrice });
  }
  if (shopifyProducts.length !== productsToCreate.length) {
    return json({ error: "One or more selected variants could not be found in Shopify." }, { status: 400 });
  }

  let campaign;
  try {
    campaign = await prisma.$transaction(async (tx) => {
      await enforceCampaignPlanLimits(tx, shop.id, entitlements.plan, shopifyProducts.length);
      const created = await tx.campaign.create({
        data: {
          shopId: shop.id,
          name,
          description: description || null,
          startDate,
          endDate,
          recurrenceIntervalDays: recurrenceIntervalDaysValue ? Number(recurrenceIntervalDaysValue) : null,
          recurrenceEndsAt,
          collectionId: collectionIdValue || null,
          collectionTitle,
          status: CampaignStatus.Draft,
          products: {
            create: shopifyProducts.map((product) => {
              let targetPrice: number;
              if (pricingType === "percentageDiscount") {
                targetPrice = product.price * (1 - pricingValue / 100);
              } else if (pricingType === "percentageIncrease") {
                targetPrice = product.price * (1 + pricingValue / 100);
              } else {
                targetPrice = pricingValue;
              }
              return {
                shopifyProductId: product.productId,
                shopifyVariantId: product.variantId,
                originalPrice: product.price.toFixed(2),
                targetPrice: Math.max(0, targetPrice).toFixed(2),
                originalCompareAtPrice: product.compareAtPrice === null ? null : product.compareAtPrice.toFixed(2),
                targetCompareAtPrice: compareAtPricingValue ? compareAtPrice?.toFixed(2) ?? null : product.compareAtPrice?.toFixed(2) ?? null,
              };
            }),
          },
        },
        select: { id: true, name: true },
      });

      await tx.activityLog.create({
        data: {
          shopId: shop.id,
          campaignId: created.id,
          action: "CAMPAIGN_CREATED",
          message: `Created campaign “${created.name}” with ${shopifyProducts.length} product variants.`,
          metadata: { pricingType, pricingValue, productCount: shopifyProducts.length, collectionId: collectionIdValue || null, recurrenceIntervalDays: recurrenceIntervalDaysValue ? Number(recurrenceIntervalDaysValue) : null },
        },
      });

      return created;
    });
  } catch (error) {
    if (error instanceof PlanLimitError) return json({ error: error.message }, { status: 403 });
    throw error;
  }

  return json({ success: true, campaignId: campaign.id, campaignName: campaign.name });
};

type SelectedVariant = {
  variantId: string;
  productId: string;
  productTitle: string;
  title: string;
  price: number;
  sku: string | null;
  imageUrl: string | null;
};

export default function NewCampaign() {
  const { currencyCode } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedVariants, setSelectedVariants] = useState<SelectedVariant[]>([]);
  const [pricingType, setPricingType] = useState("percentageDiscount");
  const [pricingValue, setPricingValue] = useState("10");
  const [stepError, setStepError] = useState("");
  const [openPicker, setOpenPicker] = useState<"product" | "variant" | "collection" | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<{ id: string; title: string } | null>(null);
  const [recurrenceIntervalDays, setRecurrenceIntervalDays] = useState("");
  const [recurrenceEndsAt, setRecurrenceEndsAt] = useState("");
  const [compareAtPricingValue, setCompareAtPricingValue] = useState("");
  const campaignCreated = fetcher.data && "campaignId" in fetcher.data
    ? fetcher.data.campaignId
    : null;

  useEffect(() => {
    if (!campaignCreated) return;
    shopify.toast.show("Campaign created");
    navigate(`/app/campaigns?selected=${encodeURIComponent(campaignCreated)}`);
  }, [campaignCreated, navigate, shopify]);

  useEffect(() => {
    if (!openPicker) return;
    const type = openPicker;
    setOpenPicker(null);
    void (async () => {
      const selection = type === "collection"
        ? await shopify.resourcePicker({ type: "collection", action: "select", multiple: false })
        : type === "product"
        ? await shopify.resourcePicker({
            type: "product",
            action: "select",
            multiple: true,
            filter: { archived: false },
          })
        : await shopify.resourcePicker({
            type: "variant",
            action: "select",
            multiple: true,
          });
      if (!selection) return;
      if (type === "collection") {
        const collection = (selection as Collection[])[0];
        if (collection) setSelectedCollection({ id: collection.id, title: collection.title });
        return;
      }

      const variants: SelectedVariant[] = type === "product"
        ? (selection as Product[]).flatMap((product) => {
          const items = product.variants.filter(
            (variant): variant is typeof variant & { id: string; price: string } =>
              Boolean(variant.id && variant.price !== undefined),
          );
          return items.map((variant) => ({
            variantId: variant.id,
            productId: product.id,
            productTitle: product.title,
            title: variant.title ?? "Default",
            price: Number(variant.price),
            sku: variant.sku ?? null,
            imageUrl: variant.image?.originalSrc ?? product.images[0]?.originalSrc ?? null,
          }));
        })
        : (selection as ProductVariant[]).map((variant) => ({
            variantId: variant.id,
            productId: variant.product.id ?? "",
            productTitle: variant.product.title ?? variant.displayName,
            title: variant.title,
            price: Number(variant.price),
            sku: variant.sku ?? null,
            imageUrl: variant.image?.originalSrc ?? null,
          }));

      setSelectedVariants((current) => {
        const combined = new Map(current.map((variant) => [variant.variantId, variant]));
        for (const variant of variants) {
          if (variant.productId && Number.isFinite(variant.price)) {
            combined.set(variant.variantId, variant);
          }
        }
        return Array.from(combined.values());
      });
      setStepError("");
    })();
  }, [openPicker, shopify]);

  const validateStep = () => {
    if (step === 0) {
      if (!name.trim()) return "Enter a campaign name.";
      if (!startDate || !endDate) return "Choose a start date and end date.";
      if (endDate < startDate) return "The end date must be on or after the start date.";
    }
    if (step === 1 && selectedVariants.length === 0 && !selectedCollection) {
      return "Select at least one product, variant, or collection.";
    }
    if (step === 2) {
      const value = Number(pricingValue);
      if (!Number.isFinite(value) || value < 0 || (pricingType !== "fixedPrice" && value === 0)) {
        return "Enter a valid price adjustment.";
      }
      if (pricingType !== "fixedPrice" && value > 100) {
        return "Percentage adjustments must be 100% or less.";
      }
    }
    return "";
  };

  const goNext = () => {
    const error = validateStep();
    if (error) {
      setStepError(error);
      return;
    }
    setStepError("");
    setStep((current) => Math.min(current + 1, wizardSteps.length - 1));
  };

  const priceFor = (variant: SelectedVariant) => {
    const value = Number(pricingValue);
    if (!Number.isFinite(value) || value < 0 || (pricingType !== "fixedPrice" && value === 0)) return variant.price;
    if (pricingType === "percentageDiscount") return variant.price * (1 - value / 100);
    if (pricingType === "percentageIncrease") return variant.price * (1 + value / 100);
    return value;
  };

  const formatMoney = (amount: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(amount);

  const pricingTypeOptions = [
    { label: "Percentage discount", value: "percentageDiscount" },
    { label: "Percentage increase", value: "percentageIncrease" },
    { label: "Fixed price", value: "fixedPrice" },
  ];

  return (
    <Page
      title="Create campaign"
      backAction={{ content: "Campaigns", url: "/app/campaigns" }}
    >
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Step {step + 1} of {wizardSteps.length}: {wizardSteps[step]}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {Math.round(((step + 1) / wizardSteps.length) * 100)}% complete
              </Text>
            </InlineStack>
            <ProgressBar progress={((step + 1) / wizardSteps.length) * 100} size="small" />
          </BlockStack>
        </Card>

        {stepError && <Banner tone="critical">{stepError}</Banner>}
        {fetcher.data && "error" in fetcher.data && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}

        {step === 0 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Campaign details</Text>
              <FormLayout>
                <TextField
                  label="Campaign name"
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                  requiredIndicator
                  maxLength={120}
                  showCharacterCount
                />
                <TextField
                  label="Description"
                  value={description}
                  onChange={setDescription}
                  autoComplete="off"
                  multiline={3}
                />
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                  <TextField
                    label="Start date"
                    type="date"
                    value={startDate}
                    onChange={setStartDate}
                    autoComplete="off"
                    requiredIndicator
                  />
                  <TextField
                    label="End date"
                    type="date"
                    value={endDate}
                    onChange={setEndDate}
                    autoComplete="off"
                    requiredIndicator
                  />
                </InlineGrid>
                <TextField label="Repeat every (days) — Pro" type="number" min="1" max="365" value={recurrenceIntervalDays} onChange={setRecurrenceIntervalDays} autoComplete="off" />
                {recurrenceIntervalDays && <TextField label="Repeat through" type="date" value={recurrenceEndsAt} onChange={setRecurrenceEndsAt} autoComplete="off" />}
                        <TextField label="Compare-at price — Pro (optional)" type="number" min="0" value={compareAtPricingValue} onChange={setCompareAtPricingValue} autoComplete="off" helpText="Sets this compare-at price when the campaign starts; restores the original value afterward." />
              </FormLayout>
            </BlockStack>
          </Card>
        )}

        {step === 1 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Select products and variants</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Choose products to include all available variants, or select individual variants.
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Button onClick={() => setOpenPicker("product")}>
                    Select products
                  </Button>
                  <Button onClick={() => setOpenPicker("collection")}>Select collection — Pro</Button>
                  <Button variant="primary" onClick={() => setOpenPicker("variant")}>
                    Select variants
                  </Button>
                </InlineStack>
              </InlineStack>              {selectedCollection && <Text as="p" variant="bodySm">Collection: {selectedCollection.title}</Text>}
              <Divider />
              {selectedVariants.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No products selected yet.
                </Text>
              ) : (
                <BlockStack gap="300">
                  {selectedVariants.map((variant) => (
                    <InlineStack key={variant.variantId} align="space-between" blockAlign="center" wrap={false}>
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <Thumbnail
                          source={variant.imageUrl ?? ""}
                          alt={variant.productTitle}
                          size="small"
                        />
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {variant.productTitle}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {variant.title}{variant.sku ? ` · SKU ${variant.sku}` : " · No SKU"}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                      <InlineStack gap="300" blockAlign="center">
                        <Text as="span" variant="bodyMd">{formatMoney(variant.price)}</Text>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => setSelectedVariants((current) => current.filter((item) => item.variantId !== variant.variantId))}
                          accessibilityLabel={`Remove ${variant.productTitle} ${variant.title}`}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
              <Text as="p" variant="bodySm" tone="subdued">
                {selectedCollection ? `Products from ${selectedCollection.title} will be resolved when the campaign is created.` : `${selectedVariants.length} product variant${selectedVariants.length === 1 ? "" : "s"} selected`}
              </Text>
            </BlockStack>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Pricing configuration</Text>
              <FormLayout>
                <ChoiceList
                  title="Pricing option"
                  choices={pricingTypeOptions}
                  selected={[pricingType]}
                  onChange={(selected) => setPricingType(selected[0] ?? "percentageDiscount")}
                />
                <TextField
                  label={pricingType === "fixedPrice" ? "New price" : "Adjustment percentage"}
                  type="number"
                  value={pricingValue}
                  onChange={setPricingValue}
                  autoComplete="off"
                  min={pricingType === "fixedPrice" ? "0" : "0.01"}
                  max={pricingType === "fixedPrice" ? undefined : "100"}
                  suffix={pricingType === "fixedPrice" ? undefined : "%"}
                  helpText={pricingType === "percentageDiscount" ? "Discount from each product’s current price." : pricingType === "percentageIncrease" ? "Increase from each product’s current price." : "Set this same price for each selected variant."}
                />
              </FormLayout>
              <Divider />
              <Text as="h3" variant="headingSm">Price preview</Text>
              <BlockStack gap="200">
                {selectedVariants.slice(0, 8).map((variant) => (
                  <InlineStack key={variant.variantId} align="space-between" blockAlign="center">
                    <Text as="span" variant="bodyMd">{variant.productTitle} · {variant.title}</Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodySm" tone="subdued">{formatMoney(variant.price)}</Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">{formatMoney(priceFor(variant))}</Text>
                    </InlineStack>
                  </InlineStack>
                ))}
                {selectedVariants.length > 8 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    And {selectedVariants.length - 8} more variants
                  </Text>
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Review and confirm</Text>
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">Campaign details</Text>
                  <Text as="p" variant="bodyMd"><strong>Name:</strong> {name}</Text>
                  <Text as="p" variant="bodyMd"><strong>Description:</strong> {description || "—"}</Text>
                  <Text as="p" variant="bodyMd"><strong>Start date:</strong> {startDate}</Text>
                  <Text as="p" variant="bodyMd"><strong>End date:</strong> {endDate}</Text>
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">Pricing</Text>
                  <Text as="p" variant="bodyMd">
                    {pricingTypeOptions.find((option) => option.value === pricingType)?.label}: {pricingType === "fixedPrice" ? formatMoney(Number(pricingValue)) : `${pricingValue}%`}
                  </Text>
                  <Text as="p" variant="bodyMd">{selectedCollection ? `All variants from ${selectedCollection.title}` : `${selectedVariants.length} variants selected`}</Text>
                </BlockStack>
              </InlineGrid>
              <Divider />
              <Text as="h3" variant="headingSm">Selected products and prices</Text>
              <BlockStack gap="200">
                {selectedVariants.map((variant) => (
                  <InlineStack key={variant.variantId} align="space-between" blockAlign="center">
                    <Text as="span" variant="bodyMd">{variant.productTitle} · {variant.title} · SKU {variant.sku || "—"}</Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodySm" tone="subdued">{formatMoney(variant.price)}</Text>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">{formatMoney(priceFor(variant))}</Text>
                    </InlineStack>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        <InlineStack align="space-between">
          <Button
            disabled={step === 0 || fetcher.state !== "idle"}
            onClick={() => {
              setStepError("");
              setStep((current) => Math.max(0, current - 1));
            }}
          >
            Back
          </Button>
          {step < wizardSteps.length - 1 ? (
            <Button variant="primary" onClick={goNext}>
              Continue
            </Button>
          ) : (
            <fetcher.Form
              method="post"
              onSubmit={(event) => {
                const validationError = validateStep();
                if (validationError) {
                  event.preventDefault();
                  setStepError(validationError);
                }
              }}
            >
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="description" value={description} />
              <input type="hidden" name="startDate" value={startDate} />
              <input type="hidden" name="endDate" value={endDate} />
              <input type="hidden" name="pricingType" value={pricingType} />
              <input type="hidden" name="pricingValue" value={pricingValue} />
              <input type="hidden" name="recurrenceIntervalDays" value={recurrenceIntervalDays} />
              <input type="hidden" name="recurrenceEndsAt" value={recurrenceEndsAt} />
              <input type="hidden" name="collectionId" value={selectedCollection?.id ?? ""} />
              <input type="hidden" name="compareAtPricingValue" value={compareAtPricingValue} />
              <input type="hidden" name="products" value={JSON.stringify(selectedVariants.map((variant) => ({
                productId: variant.productId,
                variantId: variant.variantId,
              })))} />
              <Button submit variant="primary" loading={fetcher.state !== "idle"}>
                Confirm and create campaign
              </Button>
            </fetcher.Form>
          )}
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
