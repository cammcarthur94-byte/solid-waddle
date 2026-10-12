import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

export interface CollectionCampaignVariant {
  productId: string;
  variantId: string;
  price: number;
  compareAtPrice: number | null;
}

/** Load every product and up to Shopify's 250-variant connection page for a collection. */
export async function getCollectionCampaignVariants(
  admin: AdminApiContext,
  collectionId: string,
): Promise<{ title: string; variants: CollectionCampaignVariant[] }> {
  const response = await admin.graphql(`#graphql
    query PremiumCollectionCampaign($id: ID!) {
      collection(id: $id) {
        title
        products(first: 250) {
          nodes { id }
          pageInfo { hasNextPage }
        }
      }
    }
  `, { variables: { id: collectionId }, tries: 3 });
  const result = await response.json() as {
    data?: {
      collection?: {
        title: string;
        products: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean };
        };
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };
  const collection = result.data?.collection;
  if (!response.ok || result.errors?.length || !collection) {
    throw new Error(result.errors?.map((error) => error.message).filter(Boolean).join("; ") || "Collection could not be loaded.");
  }
  if (collection.products.pageInfo.hasNextPage) {
    throw new Error("This collection contains more than 250 products; select a smaller collection.");
  }
  const variants: CollectionCampaignVariant[] = [];
  for (const product of collection.products.nodes) {
    const variantsResponse = await admin.graphql(`#graphql
      query PremiumProductVariants($id: ID!) {
        product(id: $id) {
          variants(first: 250) {
            nodes { id price compareAtPrice }
            pageInfo { hasNextPage }
          }
        }
      }
    `, { variables: { id: product.id }, tries: 3 });
    const variantsResult = await variantsResponse.json() as {
      data?: { product?: { variants: { nodes: Array<{ id: string; price: string; compareAtPrice: string | null }>; pageInfo: { hasNextPage: boolean } } } | null };
      errors?: Array<{ message?: string }>;
    };
    const productVariants = variantsResult.data?.product?.variants;
    if (!variantsResponse.ok || variantsResult.errors?.length || !productVariants) {
      throw new Error(variantsResult.errors?.map((error) => error.message).filter(Boolean).join("; ") || "Collection product variants could not be loaded.");
    }
    if (productVariants.pageInfo.hasNextPage) throw new Error("A product in this collection has more than 250 variants.");
    variants.push(...productVariants.nodes.map((variant) => ({
      productId: product.id,
      variantId: variant.id,
      price: Number(variant.price),
      compareAtPrice: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
    })));
  }
  return { title: collection.title, variants };
}

export function getNextRecurringWindow(
  startDate: Date,
  endDate: Date,
  intervalDays: number,
  recurrenceEndsAt: Date | null,
): { startDate: Date; endDate: Date } | null {
  const nextStartDate = new Date(startDate.getTime() + intervalDays * 86_400_000);
  if (recurrenceEndsAt && nextStartDate > recurrenceEndsAt) return null;
  const duration = endDate.getTime() - startDate.getTime();
  const nextEndDate = new Date(nextStartDate.getTime() + duration);
  if (recurrenceEndsAt && nextEndDate > recurrenceEndsAt) return null;
  return { startDate: nextStartDate, endDate: nextEndDate };
}
