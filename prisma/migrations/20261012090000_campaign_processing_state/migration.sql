ALTER TABLE "Campaign"
ADD COLUMN "processingToken" TEXT,
ADD COLUMN "processingLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "processingAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "processingNextAttemptAt" TIMESTAMP(3),
ADD COLUMN "lastProcessingError" TEXT;

CREATE INDEX "Campaign_status_processingNextAttemptAt_processingLeaseExpiresAt_idx"
ON "Campaign"("status", "processingNextAttemptAt", "processingLeaseExpiresAt");
