/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.d.ts';

export type UpdateCampaignVariantPricesMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variants: Array<AdminTypes.ProductVariantsBulkInput> | AdminTypes.ProductVariantsBulkInput;
}>;


export type UpdateCampaignVariantPricesMutation = { productVariantsBulkUpdate?: AdminTypes.Maybe<{ productVariants?: AdminTypes.Maybe<Array<Pick<AdminTypes.ProductVariant, 'id' | 'price' | 'compareAtPrice'>>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkUpdateUserError, 'field' | 'message'>> }> };

export type CampaignStoreCurrencyQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type CampaignStoreCurrencyQuery = { shop: Pick<AdminTypes.Shop, 'currencyCode'> };

export type PricePilotProductsQueryVariables = AdminTypes.Exact<{
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type PricePilotProductsQuery = { products: { nodes: Array<Pick<AdminTypes.Product, 'id' | 'title' | 'handle' | 'status' | 'vendor' | 'productType'>>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

export type PricePilotProductQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type PricePilotProductQuery = { product?: AdminTypes.Maybe<(
    Pick<AdminTypes.Product, 'id' | 'title' | 'handle' | 'status' | 'vendor' | 'productType'>
    & { featuredMedia?: AdminTypes.Maybe<{ preview?: AdminTypes.Maybe<{ image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url' | 'altText'>> }> }> }
  )> };

export type PricePilotProductVariantsQueryVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type PricePilotProductVariantsQuery = { product?: AdminTypes.Maybe<(
    Pick<AdminTypes.Product, 'id' | 'title'>
    & { variants: { nodes: Array<(
        Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'sku' | 'price' | 'compareAtPrice' | 'availableForSale'>
        & { selectedOptions: Array<Pick<AdminTypes.SelectedOption, 'name' | 'value'>> }
      )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } }
  )> };

export type PricePilotVariantPricesQueryVariables = AdminTypes.Exact<{
  ids: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type PricePilotVariantPricesQuery = { nodes: Array<AdminTypes.Maybe<(
    Pick<AdminTypes.ProductVariant, 'id' | 'price' | 'compareAtPrice'>
    & { product: Pick<AdminTypes.Product, 'id'> }
  )>> };

export type PricePilotCollectionsQueryVariables = AdminTypes.Exact<{
  first: AdminTypes.Scalars['Int']['input'];
  after?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
  query?: AdminTypes.InputMaybe<AdminTypes.Scalars['String']['input']>;
}>;


export type PricePilotCollectionsQuery = { collections: { nodes: Array<(
      Pick<AdminTypes.Collection, 'id' | 'title' | 'handle' | 'description'>
      & { image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url' | 'altText'>>, productsCount?: AdminTypes.Maybe<Pick<AdminTypes.Count, 'count'>> }
    )>, pageInfo: Pick<AdminTypes.PageInfo, 'hasNextPage' | 'endCursor'> } };

interface GeneratedQueryTypes {
  "#graphql\n    query CampaignStoreCurrency {\n      shop { currencyCode }\n    }\n  ": {return: CampaignStoreCurrencyQuery, variables: CampaignStoreCurrencyQueryVariables},
  "#graphql\n      query PricePilotProducts($first: Int!, $after: String, $query: String) {\n        products(first: $first, after: $after, query: $query, sortKey: TITLE) {\n          nodes {\n            id\n            title\n            handle\n            status\n            vendor\n            productType\n          }\n          pageInfo { hasNextPage endCursor }\n        }\n      }\n    ": {return: PricePilotProductsQuery, variables: PricePilotProductsQueryVariables},
  "#graphql\n      query PricePilotProduct($id: ID!) {\n        product(id: $id) {\n          id\n          title\n          handle\n          status\n          vendor\n          productType\n          featuredMedia {\n            preview {\n              image { url altText }\n            }\n          }\n        }\n      }\n    ": {return: PricePilotProductQuery, variables: PricePilotProductQueryVariables},
  "#graphql\n      query PricePilotProductVariants($productId: ID!, $first: Int!, $after: String) {\n        product(id: $productId) {\n          id\n          title\n          variants(first: $first, after: $after) {\n            nodes {\n              id\n              title\n              sku\n              price\n              compareAtPrice\n              availableForSale\n              selectedOptions { name value }\n            }\n            pageInfo { hasNextPage endCursor }\n          }\n        }\n      }\n    ": {return: PricePilotProductVariantsQuery, variables: PricePilotProductVariantsQueryVariables},
  "#graphql\n        query PricePilotVariantPrices($ids: [ID!]!) {\n          nodes(ids: $ids) {\n            ... on ProductVariant {\n              id\n              price\n              compareAtPrice\n              product { id }\n            }\n          }\n        }\n      ": {return: PricePilotVariantPricesQuery, variables: PricePilotVariantPricesQueryVariables},
  "#graphql\n      query PricePilotCollections($first: Int!, $after: String, $query: String) {\n        collections(first: $first, after: $after, query: $query, sortKey: TITLE) {\n          nodes {\n            id\n            title\n            handle\n            description\n            image { url altText }\n            productsCount { count }\n          }\n          pageInfo { hasNextPage endCursor }\n        }\n      }\n    ": {return: PricePilotCollectionsQuery, variables: PricePilotCollectionsQueryVariables},
}

interface GeneratedMutationTypes {
  "mutation UpdateCampaignVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n  productVariantsBulkUpdate(\n    productId: $productId\n    variants: $variants\n    allowPartialUpdates: false\n  ) {\n    productVariants {\n      id\n      price\n      compareAtPrice\n    }\n    userErrors {\n      field\n      message\n    }\n  }\n}": {return: UpdateCampaignVariantPricesMutation, variables: UpdateCampaignVariantPricesMutationVariables},
  "#graphql\nmutation UpdateCampaignVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {\n    productVariants { id price compareAtPrice }\n    userErrors { field message }\n  }\n}": {return: UpdateCampaignVariantPricesMutation, variables: UpdateCampaignVariantPricesMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
