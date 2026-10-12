# PricePilot

PricePilot is an embedded Shopify Admin app scaffold built with Shopify CLI, Remix, TypeScript, Polaris, App Bridge, Prisma, and PostgreSQL.

## Database

The project is linked to Neon project `super-wind-92587221`, branch `production`. Neon CLI setup and MCP are configured for local tooling. The linked Neon credentials are in the ignored `.env.local`; do not commit them. The Neon policy is in [neon.ts](neon.ts).

The PostgreSQL Prisma schema contains the Shopify OAuth `Session` model plus `Shop`, `Campaign`, `CampaignProduct`, and `ActivityLog`. Campaign status is an enum (`Draft`, `Scheduled`, `Running`, `Completed`, `Cancelled`, `Failed`). Product prices use PostgreSQL `Decimal(10,2)`.

Database migrations are committed under `prisma/migrations`; apply pending migrations with `npm run db:setup` before starting the app or worker. Generate the Prisma Client/types with `npx prisma generate`. Domain TypeScript types are exported from `app/types/campaign.ts`; status values are in `app/types/campaign-status.ts`.

## Shopify app setup

Prerequisites: Node.js 20.19+ (or 22.12+), Shopify Partner / Dev Dashboard access, a development store, and Shopify CLI.

1. Install dependencies with `npm install`.
2. Link your Shopify CLI app configuration using `shopify app config link`, then set `client_id` in `shopify.app.toml` and sign in when prompted.
3. Start the embedded app with `npm run dev -- --store your-development-store.myshopify.com`.

To use the included local PostgreSQL service instead of Neon, run `npm run db:up`, set `DATABASE_URL` in `.env` to `postgresql://pricepilot:pricepilot@localhost:5432/pricepilot?schema=public`, then run `npm run setup`.

## App pages

The embedded app has Dashboard, Campaigns, Activity Logs, and Settings navigation. Campaigns are created as drafts, then explicitly scheduled from the Campaigns page. A separate worker polls every minute, applies target prices at the start date, restores unchanged campaign prices at the end date, and logs processing activity and failures. Restoration deliberately skips variants whose prices were changed by a merchant while the campaign was running.

### Campaign processor worker

Apply the new database migration before running the worker. Start it in a separate long-running process with `npm run worker:campaigns`; run this alongside the Remix web process with access to the same PostgreSQL database and Shopify app credentials. The worker uses offline Shopify sessions stored by the app. Keep at most one active worker per deployment (database leases protect against accidental concurrent workers).

## Shopify App Pricing

PricePilot uses Shopify App Pricing (Managed Pricing) for recurring charges. Create and describe these monthly public plans in your Partner Dashboard; the app reads plan handles from the Partner API and does not issue manual Billing API charges:

| Plan handle | Price | Included limits |
| --- | ---: | --- |
| `free` | Free | 1 active campaign, 20 products across active campaigns |
| `starter` | $9/month | 10 active campaigns, 500 products across active campaigns |
| `growth` | $19/month | Unlimited campaigns and products |
| `pro` | $39/month | Unlimited campaigns and products; premium features can be added later |

Use exactly those case-sensitive handles when configuring plans. Ensure the app is distributed as a public app with Shopify App Pricing enabled. Create a Partner API client under Partner Dashboard → Settings → Partner API clients, grant **Manage apps**, and configure `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_ACCESS_TOKEN`, and `SHOPIFY_APP_GID` (the app's `gid://shopify/App/...`). `SHOPIFY_APP_HANDLE` must match the app handle configured in Shopify (currently `pricepilot`). The access token is a secret; keep it in deployment secrets, never commit it. `SHOPIFY_PARTNER_API_VERSION` defaults to `2026-07`.

Apply migrations with `npm run db:setup`. Shopify hosts plan selection at `/charges/{app-handle}/pricing_plans`; merchants without an active paid subscription can use the app on the Free tier, and the Settings page links to Shopify to choose or manage a plan. Entitlements are verified against Partner API and cached for five minutes; no active subscription maps to Free, while Partner API errors fail closed. Plan downgrades do not remove existing campaigns, but scheduling a campaign is blocked until usage fits the selected plan. Product caps apply to each campaign and to the aggregate products in active campaigns.

## Useful commands

- `npm run build` — build the Remix app
- `npx tsc --noEmit` — typecheck
- `npm run lint` — lint
- `npx prisma migrate dev` — create a development migration
- `npx prisma migrate deploy` — apply committed migrations
- `npx prisma generate` — generate Prisma Client/types
