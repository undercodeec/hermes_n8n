-- Additive migration for paid acquisition attribution. It does not alter the
-- existing WhatsApp campaign tables or reinterpret CampaignSource/AdsMetadata.
CREATE TYPE "AdvertisingProvider" AS ENUM ('GOOGLE_ADS');
CREATE TYPE "AdvertisingAttributionStatus" AS ENUM ('UNCONFIRMED', 'CONFIRMED', 'EXPIRED', 'REVOKED');
CREATE TYPE "AdvertisingConsentChoice" AS ENUM ('UNSPECIFIED', 'GRANTED', 'DENIED');
CREATE TYPE "AdvertisingEventType" AS ENUM ('WHATSAPP_CLICK', 'CONVERSATION_STARTED', 'LEAD_QUALIFIED', 'MEETING_CONFIRMED', 'PROPOSAL_SENT', 'CONTRACT_WON', 'CONTRACT_LOST');
CREATE TYPE "AdvertisingSyncStatus" AS ENUM ('NOT_ELIGIBLE', 'PENDING', 'QUEUED', 'VALIDATED', 'SUBMITTED', 'ACCEPTED', 'PARTIAL', 'RETRYING', 'FAILED', 'CANCELLED');

ALTER TABLE "leads"
  ADD COLUMN "serviceRequested" TEXT,
  ADD COLUMN "proposalValue" DECIMAL(18,2),
  ADD COLUMN "contractedAmount" DECIMAL(18,2),
  ADD COLUMN "revenueReceived" DECIMAL(18,2),
  ADD COLUMN "commercialCurrency" VARCHAR(3),
  ADD COLUMN "contractReference" TEXT,
  ADD COLUMN "commercialOwnerId" TEXT;

CREATE TABLE "advertising_integrations" (
  "id" TEXT NOT NULL,
  "provider" "AdvertisingProvider" NOT NULL,
  "conversionSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
  "metricsSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
  "accountId" TEXT,
  "loginAccountId" TEXT,
  "accountCurrency" VARCHAR(3),
  "accountTimeZone" TEXT,
  "lastMetricsSyncAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "advertising_integrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "advertising_touches" (
  "id" TEXT NOT NULL,
  "provider" "AdvertisingProvider" NOT NULL DEFAULT 'GOOGLE_ADS',
  "channel" TEXT NOT NULL DEFAULT 'paid_search',
  "source" TEXT NOT NULL DEFAULT 'google',
  "referenceHash" VARCHAR(64) NOT NULL,
  "referenceLast4" VARCHAR(4) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "useCount" INTEGER NOT NULL DEFAULT 0,
  "maxUses" INTEGER NOT NULL DEFAULT 1,
  "gclid" TEXT,
  "gbraid" TEXT,
  "wbraid" TEXT,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "utmContent" TEXT,
  "utmTerm" TEXT,
  "landingPage" TEXT,
  "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "adStorage" "AdvertisingConsentChoice" NOT NULL DEFAULT 'UNSPECIFIED',
  "analyticsStorage" "AdvertisingConsentChoice" NOT NULL DEFAULT 'UNSPECIFIED',
  "adUserData" "AdvertisingConsentChoice" NOT NULL DEFAULT 'UNSPECIFIED',
  "adPersonalization" "AdvertisingConsentChoice" NOT NULL DEFAULT 'UNSPECIFIED',
  "consentSource" TEXT,
  "consentRecordedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "advertising_touches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "advertising_attributions" (
  "id" TEXT NOT NULL,
  "touchId" TEXT NOT NULL,
  "contactId" TEXT,
  "leadId" TEXT,
  "conversationId" TEXT,
  "inboundMessageId" TEXT,
  "status" "AdvertisingAttributionStatus" NOT NULL DEFAULT 'UNCONFIRMED',
  "attributedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revocationReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "advertising_attributions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "advertising_conversions" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "eventType" "AdvertisingEventType" NOT NULL,
  "attributionId" TEXT,
  "touchId" TEXT,
  "contactId" TEXT,
  "leadId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "source" TEXT NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "verifiedByUserId" TEXT,
  "value" DECIMAL(18,2),
  "currency" VARCHAR(3),
  "commercialReference" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "advertising_conversions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "advertising_conversion_mappings" (
  "id" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "eventType" "AdvertisingEventType" NOT NULL,
  "conversionActionId" TEXT NOT NULL,
  "exportEnabled" BOOLEAN NOT NULL DEFAULT false,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "advertising_conversion_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "advertising_sync_jobs" (
  "id" TEXT NOT NULL,
  "conversionId" TEXT NOT NULL,
  "status" "AdvertisingSyncStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "validateOnly" BOOLEAN NOT NULL DEFAULT true,
  "googleRequestId" TEXT,
  "warnings" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "nextAttemptAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "diagnosedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "advertising_sync_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "advertising_daily_metrics" (
  "id" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "campaignName" TEXT NOT NULL,
  "campaignStatus" TEXT NOT NULL,
  "metricDate" DATE NOT NULL,
  "impressions" BIGINT NOT NULL,
  "clicks" BIGINT NOT NULL,
  "costMicros" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "accountTimeZone" TEXT NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "advertising_daily_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "advertising_integrations_provider_key" ON "advertising_integrations"("provider");
CREATE UNIQUE INDEX "advertising_touches_referenceHash_key" ON "advertising_touches"("referenceHash");
CREATE INDEX "advertising_touches_expiresAt_consumedAt_idx" ON "advertising_touches"("expiresAt", "consumedAt");
CREATE INDEX "advertising_touches_gclid_idx" ON "advertising_touches"("gclid");
CREATE INDEX "advertising_touches_gbraid_idx" ON "advertising_touches"("gbraid");
CREATE INDEX "advertising_touches_wbraid_idx" ON "advertising_touches"("wbraid");
CREATE INDEX "advertising_touches_utmCampaign_createdAt_idx" ON "advertising_touches"("utmCampaign", "createdAt");
CREATE UNIQUE INDEX "advertising_attributions_inboundMessageId_key" ON "advertising_attributions"("inboundMessageId");
CREATE UNIQUE INDEX "advertising_attributions_touchId_contactId_key" ON "advertising_attributions"("touchId", "contactId");
CREATE INDEX "advertising_attributions_contactId_attributedAt_idx" ON "advertising_attributions"("contactId", "attributedAt");
CREATE INDEX "advertising_attributions_leadId_attributedAt_idx" ON "advertising_attributions"("leadId", "attributedAt");
CREATE INDEX "advertising_attributions_status_createdAt_idx" ON "advertising_attributions"("status", "createdAt");
CREATE UNIQUE INDEX "advertising_conversions_idempotencyKey_key" ON "advertising_conversions"("idempotencyKey");
CREATE UNIQUE INDEX "advertising_conversions_leadId_eventType_key" ON "advertising_conversions"("leadId", "eventType");
CREATE INDEX "advertising_conversions_eventType_occurredAt_idx" ON "advertising_conversions"("eventType", "occurredAt");
CREATE INDEX "advertising_conversions_touchId_occurredAt_idx" ON "advertising_conversions"("touchId", "occurredAt");
CREATE UNIQUE INDEX "advertising_conversion_mappings_eventType_key" ON "advertising_conversion_mappings"("eventType");
CREATE INDEX "advertising_conversion_mappings_integrationId_exportEnabled_idx" ON "advertising_conversion_mappings"("integrationId", "exportEnabled");
CREATE UNIQUE INDEX "advertising_sync_jobs_conversionId_key" ON "advertising_sync_jobs"("conversionId");
CREATE INDEX "advertising_sync_jobs_status_nextAttemptAt_idx" ON "advertising_sync_jobs"("status", "nextAttemptAt");
CREATE INDEX "advertising_sync_jobs_googleRequestId_idx" ON "advertising_sync_jobs"("googleRequestId");
CREATE UNIQUE INDEX "advertising_daily_metrics_integrationId_campaignId_metricDate_key" ON "advertising_daily_metrics"("integrationId", "campaignId", "metricDate");
CREATE INDEX "advertising_daily_metrics_metricDate_campaignStatus_idx" ON "advertising_daily_metrics"("metricDate", "campaignStatus");

ALTER TABLE "advertising_attributions" ADD CONSTRAINT "advertising_attributions_touchId_fkey" FOREIGN KEY ("touchId") REFERENCES "advertising_touches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "advertising_attributions" ADD CONSTRAINT "advertising_attributions_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advertising_attributions" ADD CONSTRAINT "advertising_attributions_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advertising_attributions" ADD CONSTRAINT "advertising_attributions_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advertising_attributions" ADD CONSTRAINT "advertising_attributions_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advertising_conversions" ADD CONSTRAINT "advertising_conversions_attributionId_fkey" FOREIGN KEY ("attributionId") REFERENCES "advertising_attributions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advertising_conversions" ADD CONSTRAINT "advertising_conversions_touchId_fkey" FOREIGN KEY ("touchId") REFERENCES "advertising_touches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advertising_conversions" ADD CONSTRAINT "advertising_conversions_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advertising_conversions" ADD CONSTRAINT "advertising_conversions_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advertising_conversion_mappings" ADD CONSTRAINT "advertising_conversion_mappings_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "advertising_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "advertising_sync_jobs" ADD CONSTRAINT "advertising_sync_jobs_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "advertising_conversions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "advertising_daily_metrics" ADD CONSTRAINT "advertising_daily_metrics_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "advertising_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
