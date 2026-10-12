import { randomUUID } from "node:crypto";
import { CampaignStatus, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { getOfflineAdmin } from "../shopify.server";
import { getCurrentVariantPrices } from "./shopify-admin.server";
import { setCampaignVariantPrices } from "./shopify-campaign-prices.server";
import { getNextRecurringWindow } from "./shopify-premium-campaigns.server";

const CLAIM_LEASE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;

type Transition = "start" | "complete";
type Claim = { campaignId: string; token: string };
type ClaimedCampaign = Prisma.CampaignGetPayload<{
  include: { products: true; shop: { select: { shopDomain: true } } };
}>;

export interface CampaignProcessorOptions {
  now?: Date;
  limit?: number;
  logger?: Pick<Console, "error">;
}

export interface CampaignProcessorSummary {
  claimed: number;
  completed: number;
  failed: number;
}

function getDueWhere(transition: Transition, now: Date): Prisma.CampaignWhereInput {
  return {
    status: transition === "start" ? CampaignStatus.Scheduled : CampaignStatus.Running,
    [transition === "start" ? "startDate" : "endDate"]: { lte: now },
    AND: [
      { OR: [{ processingNextAttemptAt: null }, { processingNextAttemptAt: { lte: now } }] },
    ],
  };
}

async function claimDueCampaigns(
  transition: Transition,
  now: Date,
  limit: number,
): Promise<Claim[]> {
  const due = await prisma.campaign.findMany({
    where: {
      ...getDueWhere(transition, now),
      OR: [
        { processingToken: null },
        { processingLeaseExpiresAt: { lte: now } },
      ],
    },
    select: { id: true },
    orderBy: [
      { [transition === "start" ? "startDate" : "endDate"]: "asc" },
      { id: "asc" },
    ],
    take: limit,
  });
  const dateColumn = Prisma.raw(transition === "start" ? '"startDate"' : '"endDate"');
  const status = transition === "start" ? CampaignStatus.Scheduled : CampaignStatus.Running;
  const claims: Claim[] = [];

  for (const { id } of due) {
    const token = randomUUID();
    const claimed = await prisma.$queryRaw<Array<{ id: string; shopId: string; name: string }>>(Prisma.sql`
      UPDATE "Campaign"
      SET "processingToken" = ${token},
          "processingLeaseExpiresAt" = ${new Date(now.getTime() + CLAIM_LEASE_MS)}
      WHERE "id" = ${id}
        AND "status" = ${status}::"CampaignStatus"
        AND ${dateColumn} <= ${now}
        AND ("processingNextAttemptAt" IS NULL OR "processingNextAttemptAt" <= ${now})
        AND ("processingToken" IS NULL OR "processingLeaseExpiresAt" IS NULL OR "processingLeaseExpiresAt" <= ${now})
      RETURNING "id", "shopId", "name"
    `);
    if (claimed.length === 0) continue;
    claims.push({ campaignId: id, token });
    const [campaign] = claimed;
    try {
      await prisma.activityLog.create({
        data: {
          shopId: campaign.shopId,
          campaignId: campaign.id,
          action: transition === "start" ? "CAMPAIGN_START_PROCESSING" : "CAMPAIGN_COMPLETION_PROCESSING",
          message: `Campaign “${campaign.name}” began ${transition} processing.`,
          metadata: { transition },
        },
      });
    } catch (error) {
      console.error(`[campaign-processor] Could not log processing start for ${id}.`, error);
    }
  }
  return claims;
}

function nextRetryAt(now: Date, attempt: number): Date {
  const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 12), MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delay);
}

async function logFailure(
  campaign: ClaimedCampaign,
  token: string,
  transition: Transition,
  error: unknown,
  logger: Pick<Console, "error">,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[campaign-processor] ${transition} failed for campaign ${campaign.id}`, error);
  const attempt = campaign.processingAttempts + 1;
  const retryAt = nextRetryAt(new Date(), attempt);

  await prisma.$transaction(async (tx) => {
    const released = await tx.campaign.updateMany({
      where: { id: campaign.id, processingToken: token },
      data: {
        processingAttempts: { increment: 1 },
        processingNextAttemptAt: retryAt,
        processingLeaseExpiresAt: null,
        processingToken: null,
        lastProcessingError: message.slice(0, 4000),
      },
    });
    if (!released.count) return;
    await tx.activityLog.create({
      data: {
        shopId: campaign.shopId,
        campaignId: campaign.id,
        action: transition === "start" ? "CAMPAIGN_START_FAILED" : "CAMPAIGN_COMPLETION_FAILED",
        message: `Campaign ${transition} attempt ${attempt} failed: ${message}`.slice(0, 4000),
        metadata: { transition, attempt, retryAt: retryAt.toISOString() },
      },
    });
  });
}

async function processClaim(
  claim: Claim,
  transition: Transition,
  now: Date,
  logger: Pick<Console, "error">,
): Promise<"completed" | "failed" | "stale"> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: claim.campaignId, processingToken: claim.token },
    include: { products: true, shop: { select: { shopDomain: true } } },
  });
  if (!campaign) return "stale";

  let writeFinished = false;
  let lostClaim = false;
  const heartbeat = setInterval(() => {
    void prisma.campaign.updateMany({
      where: { id: campaign.id, processingToken: claim.token },
      data: { processingLeaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS) },
    }).then((result) => {
      if (result.count === 0 && !writeFinished) {
        lostClaim = true;
        clearInterval(heartbeat);
        logger.error(`[campaign-processor] Lost processing lease for ${campaign.id}.`);
      }
    }).catch((error: unknown) => {
      lostClaim = true;
      clearInterval(heartbeat);
      logger.error(`[campaign-processor] Lease renewal failed for ${campaign.id}.`, error);
    });
  }, HEARTBEAT_MS);

  try {
    if (campaign.products.length === 0) throw new Error("Campaign has no variants to update.");
    const { admin } = await getOfflineAdmin(campaign.shop.shopDomain);
    let productsToUpdate = campaign.products;
    let skippedMerchantChanges: string[] = [];

    if (transition === "complete") {
      const currentPrices = await getCurrentVariantPrices(
        admin,
        campaign.products.map((product) => product.shopifyVariantId),
      );
      const currentPriceByVariant = new Map(
        currentPrices.map((variant) => [variant.id, {
          price: Math.round(Number(variant.price) * 100),
          compareAtPrice: variant.compareAtPrice === null ? null : Math.round(Number(variant.compareAtPrice) * 100),
        }]),
      );
      productsToUpdate = campaign.products.filter((product) => {
        const current = currentPriceByVariant.get(product.shopifyVariantId);
        const priceMatches = current?.price === Math.round(Number(product.targetPrice) * 100);
        const compareAtMatches = product.targetCompareAtPrice === null ||
          current?.compareAtPrice === Math.round(Number(product.targetCompareAtPrice) * 100);
        if (priceMatches && compareAtMatches) return true;
        skippedMerchantChanges.push(product.shopifyVariantId);
        return false;
      });
    }

    if (productsToUpdate.length > 0) {
      await setCampaignVariantPrices(
        admin,
        productsToUpdate,
        (product) => (transition === "start" ? product.targetPrice : product.originalPrice).toFixed(2),
        (product) => {
          if (product.targetCompareAtPrice === null) return undefined;
          const value = transition === "start" ? product.targetCompareAtPrice : product.originalCompareAtPrice;
          return value === null ? null : value.toFixed(2);
        },
      );
    }
    if (skippedMerchantChanges.length > 0) {
      try {
        await prisma.activityLog.create({
          data: {
            shopId: campaign.shopId,
            campaignId: campaign.id,
            action: "CAMPAIGN_PRICE_RESTORE_SKIPPED",
            message: `Skipped restoring ${skippedMerchantChanges.length} variant(s) because their prices changed after the campaign started.`,
            metadata: {
              skippedVariantCount: skippedMerchantChanges.length,
              variantIds: skippedMerchantChanges.slice(0, 100),
            },
          },
        });
      } catch (error) {
        logger.error(`[campaign-processor] Could not log skipped restorations for ${campaign.id}.`, error);
      }
    }

    writeFinished = true;
    clearInterval(heartbeat);
    if (lostClaim) return "stale";

    const nextRecurringWindow = transition === "complete" && campaign.recurrenceIntervalDays && campaign.startDate && campaign.endDate
      ? getNextRecurringWindow(campaign.startDate, campaign.endDate, campaign.recurrenceIntervalDays, campaign.recurrenceEndsAt)
      : null;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.campaign.updateMany({
        where: { id: campaign.id, processingToken: claim.token, status: campaign.status },
        data: {
          status: transition === "start" ? CampaignStatus.Running : CampaignStatus.Completed,
          ...(nextRecurringWindow
            ? { status: CampaignStatus.Scheduled, startDate: nextRecurringWindow.startDate, endDate: nextRecurringWindow.endDate }
            : {}),
          processingToken: null,
          processingLeaseExpiresAt: null,
          processingAttempts: 0,
          processingNextAttemptAt: null,
          lastProcessingError: null,
        },
      });
      if (!result.count) return false;
      await tx.activityLog.create({
        data: {
          shopId: campaign.shopId,
          campaignId: campaign.id,
          action: transition === "start" ? "CAMPAIGN_STARTED" : nextRecurringWindow ? "CAMPAIGN_RECURRENCE_COMPLETED" : "CAMPAIGN_COMPLETED",
          message: transition === "start"
              ? `Campaign “${campaign.name}” started; updated prices for ${campaign.products.length} variant(s).`
              : nextRecurringWindow
                ? `Campaign “${campaign.name}” completed and its next occurrence was scheduled.`
                : `Campaign “${campaign.name}” completed; restored ${productsToUpdate.length} variant(s), skipping ${skippedMerchantChanges.length} merchant-edited variant(s).`,
          metadata: {
            transition,
            productCount: campaign.products.length,
            restoredCount: productsToUpdate.length,
            skippedMerchantChangeCount: skippedMerchantChanges.length,
            processedAt: now.toISOString(),
          },
        },
      });
      return true;
    });
    return updated ? "completed" : "stale";
  } catch (error) {
    if (lostClaim) return "stale";

    if (transition === "start" && campaign.products.length > 0 && !lostClaim) {
      try {
        const lease = await prisma.campaign.findFirst({
          where: {
            id: campaign.id,
            processingToken: claim.token,
            processingLeaseExpiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (lease) {
          const { admin } = await getOfflineAdmin(campaign.shop.shopDomain);
          await setCampaignVariantPrices(
            admin,
            campaign.products,
            (product) => product.originalPrice.toFixed(2),
            (product) => product.targetCompareAtPrice === null ? undefined : product.originalCompareAtPrice === null ? null : product.originalCompareAtPrice.toFixed(2),
          );
        }
      } catch (rollbackError) {
        logger.error(`[campaign-processor] Price rollback failed for ${campaign.id}.`, rollbackError);
      }
    }
    try {
      await logFailure(campaign, claim.token, transition, error, logger);
    } catch (loggingError) {
      logger.error(`[campaign-processor] Could not persist failure for ${campaign.id}.`, loggingError);
    }
    return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}

/** Process due starts and completions using atomic claims and idempotent absolute price updates. */
export async function processDueCampaigns(
  options: CampaignProcessorOptions = {},
): Promise<CampaignProcessorSummary> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError("Processor time must be a valid date.");
  const requestedLimit = options.limit ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new RangeError("Processor batch limit must be a positive integer.");
  }
  const limit = Math.min(requestedLimit, 100);
  const logger = options.logger ?? console;
  const summary: CampaignProcessorSummary = { claimed: 0, completed: 0, failed: 0 };

  for (const transition of ["start", "complete"] as const) {
    let claims: Claim[];
    try {
      claims = await claimDueCampaigns(transition, now, limit);
    } catch (error) {
      summary.failed += 1;
      logger.error(`[campaign-processor] Could not claim ${transition} campaigns.`, error);
      continue;
    }
    summary.claimed += claims.length;
    for (const claim of claims) {
      try {
        const result = await processClaim(claim, transition, now, logger);
        if (result === "completed") summary.completed += 1;
        if (result === "failed") summary.failed += 1;
      } catch (error) {
        summary.failed += 1;
        logger.error(`[campaign-processor] Unexpected error for ${claim.campaignId}.`, error);
      }
    }
  }
  return summary;
}
