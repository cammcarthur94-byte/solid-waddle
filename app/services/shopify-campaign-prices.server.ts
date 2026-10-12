import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { CampaignProduct } from "@prisma/client";
import type { UpdateCampaignVariantPricesMutation } from "../types/admin.generated";

const MAX_VARIANTS_PER_MUTATION = 250;
const SHOPIFY_RETRIES = 3;

export class ShopifyCampaignPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyCampaignPriceError";
  }
}

/** Set absolute variant prices sequentially in product-scoped batches for safe retries. */
export async function setCampaignVariantPrices(
  admin: AdminApiContext,
  products: CampaignProduct[],
  getPrice: (product: CampaignProduct) => string,
  getCompareAtPrice?: (product: CampaignProduct) => string | null | undefined,
): Promise<void> {
  const variantsByProduct = new Map<string, Array<{ id: string; price: string; compareAtPrice?: string | null }>>();
  for (const product of products) {
    const variants = variantsByProduct.get(product.shopifyProductId) ?? [];
    const variant: { id: string; price: string; compareAtPrice?: string | null } = {
      id: product.shopifyVariantId,
      price: getPrice(product),
    };
    const compareAtPrice = getCompareAtPrice?.(product);
    if (compareAtPrice !== undefined) variant.compareAtPrice = compareAtPrice;
    variants.push(variant);
    variantsByProduct.set(product.shopifyProductId, variants);
  }

  for (const [productId, variants] of variantsByProduct) {
    for (let offset = 0; offset < variants.length; offset += MAX_VARIANTS_PER_MUTATION) {
      const batch = variants.slice(offset, offset + MAX_VARIANTS_PER_MUTATION);
      const response = await admin.graphql(
        `#graphql
mutation UpdateCampaignVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    productVariants { id price compareAtPrice }
    userErrors { field message }
  }
}`,
        { variables: { productId, variants: batch }, tries: SHOPIFY_RETRIES },
      );
      const result = (await response.json()) as {
        data?: UpdateCampaignVariantPricesMutation;
        errors?: Array<{ message?: string }>;
      };
      if (result.errors?.length) {
        throw new ShopifyCampaignPriceError(
          result.errors.map((error) => error.message ?? "Shopify GraphQL error").join("; "),
        );
      }

      const payload = result.data?.productVariantsBulkUpdate;
      if (!payload) throw new ShopifyCampaignPriceError("Shopify returned no variant update result.");
      if (payload.userErrors.length) {
        throw new ShopifyCampaignPriceError(payload.userErrors.map((error) => error.message).join("; "));
      }
      const updatedIds = new Set((payload.productVariants ?? []).map((variant) => variant.id));
      const missingCount = batch.filter((variant) => !updatedIds.has(variant.id)).length;
      if (missingCount) {
        throw new ShopifyCampaignPriceError(`Shopify did not confirm ${missingCount} variant update(s).`);
      }
    }
  }
}
