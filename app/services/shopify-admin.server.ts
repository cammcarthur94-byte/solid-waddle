import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type {
  PricePilotCollectionsQuery,
  PricePilotProductQuery,
  PricePilotProductVariantsQuery,
  PricePilotProductsQuery,
  PricePilotVariantPricesQuery,
} from "../types/admin.generated";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const VARIANT_ID_BATCH_SIZE = 250;
const GRAPHQL_RETRIES = 3;

type GraphQLData<T> = { data?: T; errors?: Array<{ message?: string }> };

export class ShopifyAdminGraphQLError extends Error {
  constructor(operation: string, messages: string[]) {
    super(`${operation} failed: ${messages.join("; ")}`);
    this.name = "ShopifyAdminGraphQLError";
  }
}

function readData<T>(result: unknown, operation: string): T {
  const payload = result as GraphQLData<T>;
  if (payload.errors?.length) {
    throw new ShopifyAdminGraphQLError(
      operation,
      payload.errors.map((error) => error.message ?? "Unknown GraphQL error"),
    );
  }
  if (payload.data === undefined || payload.data === null) {
    throw new ShopifyAdminGraphQLError(operation, ["Shopify returned no data"]);
  }
  return payload.data;
}

function getPageSize(first: number | undefined): number {
  const pageSize = first ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`Page size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return pageSize;
}

export type ProductPage = PricePilotProductsQuery["products"];
export type ProductDetails = NonNullable<PricePilotProductQuery["product"]>;
export type ProductVariantPage = NonNullable<PricePilotProductVariantsQuery["product"]>;
export type ProductVariant = ProductVariantPage["variants"]["nodes"][number];
export type CollectionPage = PricePilotCollectionsQuery["collections"];
export type CurrentVariantPrice = NonNullable<PricePilotVariantPricesQuery["nodes"][number]>;

export interface ProductPageOptions {
  first?: number;
  after?: string | null;
  query?: string | null;
}

/** Retrieve one cursor-paginated page of products and their basic details. */
export async function getProducts(
  admin: AdminApiContext,
  options: ProductPageOptions = {},
): Promise<ProductPage> {
  const response = await admin.graphql(
    `#graphql
      query PricePilotProducts($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query, sortKey: TITLE) {
          nodes {
            id
            title
            handle
            status
            vendor
            productType
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
    {
      variables: {
        first: getPageSize(options.first),
        after: options.after ?? null,
        query: options.query ?? null,
      },
      tries: GRAPHQL_RETRIES,
    },
  );
  const data = readData<PricePilotProductsQuery>(await response.json(), "Product query");
  return data.products;
}

/** Retrieve the details for one product by Shopify global ID. */
export async function getProduct(
  admin: AdminApiContext,
  id: string,
): Promise<ProductDetails | null> {
  const response = await admin.graphql(
    `#graphql
      query PricePilotProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          status
          vendor
          productType
          featuredMedia {
            preview {
              image { url altText }
            }
          }
        }
      }
    `,
    { variables: { id }, tries: GRAPHQL_RETRIES },
  );
  const data = readData<PricePilotProductQuery>(await response.json(), "Product lookup");
  return data.product ?? null;
}

/** Retrieve one cursor-paginated page of variants, including each current price. */
export async function getProductVariants(
  admin: AdminApiContext,
  productId: string,
  options: Omit<ProductPageOptions, "query"> = {},
): Promise<ProductVariantPage | null> {
  const response = await admin.graphql(
    `#graphql
      query PricePilotProductVariants($productId: ID!, $first: Int!, $after: String) {
        product(id: $productId) {
          id
          title
          variants(first: $first, after: $after) {
            nodes {
              id
              title
              sku
              price
              compareAtPrice
              availableForSale
              selectedOptions { name value }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `,
    {
      variables: {
        productId,
        first: getPageSize(options.first),
        after: options.after ?? null,
      },
      tries: GRAPHQL_RETRIES,
    },
  );
  const data = readData<PricePilotProductVariantsQuery>(
    await response.json(),
    "Product variants query",
  );
  return data.product ?? null;
}

/** Retrieve current prices for variant IDs, using sequential batches within Shopify's 250-ID input limit. */
export async function getCurrentVariantPrices(
  admin: AdminApiContext,
  variantIds: string[],
): Promise<CurrentVariantPrice[]> {
  const uniqueIds = Array.from(new Set(variantIds));
  if (uniqueIds.length === 0) return [];
  const prices: CurrentVariantPrice[] = [];

  for (let index = 0; index < uniqueIds.length; index += VARIANT_ID_BATCH_SIZE) {
    const response = await admin.graphql(
      `#graphql
        query PricePilotVariantPrices($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              price
              compareAtPrice
              product { id }
            }
          }
        }
      `,
      {
        variables: { ids: uniqueIds.slice(index, index + VARIANT_ID_BATCH_SIZE) },
        tries: GRAPHQL_RETRIES,
      },
    );
    const data = readData<PricePilotVariantPricesQuery>(
      await response.json(),
      "Current variant prices query",
    );
    prices.push(...data.nodes.filter((node): node is CurrentVariantPrice => node !== null));
  }

  return prices;
}

/** Retrieve one cursor-paginated page of collections. Collection reads require read_products. */
export async function getCollections(
  admin: AdminApiContext,
  options: ProductPageOptions = {},
): Promise<CollectionPage> {
  const response = await admin.graphql(
    `#graphql
      query PricePilotCollections($first: Int!, $after: String, $query: String) {
        collections(first: $first, after: $after, query: $query, sortKey: TITLE) {
          nodes {
            id
            title
            handle
            description
            image { url altText }
            productsCount { count }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
    {
      variables: {
        first: getPageSize(options.first),
        after: options.after ?? null,
        query: options.query ?? null,
      },
      tries: GRAPHQL_RETRIES,
    },
  );
  const data = readData<PricePilotCollectionsQuery>(await response.json(), "Collections query");
  return data.collections;
}
