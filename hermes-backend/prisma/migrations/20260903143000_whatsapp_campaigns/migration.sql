-- Official WhatsApp template campaigns. Imported contacts remain contacts until inbound activity creates a lead.
CREATE TYPE "MarketingConsentStatus" AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT');
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'REPLIED', 'FAILED', 'SKIPPED');

ALTER TABLE "contacts"
  ADD COLUMN "marketingConsentStatus" "MarketingConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "marketingConsentAt" TIMESTAMP(3),
  ADD COLUMN "marketingConsentSource" TEXT,
  ADD COLUMN "marketingOptOutAt" TIMESTAMP(3);

CREATE TABLE "campaigns" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "templateName" TEXT NOT NULL,
  "templateLanguage" TEXT NOT NULL,
  "templateCategory" TEXT,
  "headerVideoMediaId" TEXT,
  "headerVideoUrl" TEXT,
  "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "totalRecipients" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "pausedAt" TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "campaign_recipients" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
  "wamid" TEXT,
  "metaTimestamp" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "repliedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_recipients_campaignId_contactId_key" ON "campaign_recipients"("campaignId", "contactId");
CREATE UNIQUE INDEX "campaign_recipients_wamid_key" ON "campaign_recipients"("wamid");
CREATE INDEX "campaigns_status_createdAt_idx" ON "campaigns"("status", "createdAt");
CREATE INDEX "campaign_recipients_campaignId_status_idx" ON "campaign_recipients"("campaignId", "status");
CREATE INDEX "campaign_recipients_contactId_createdAt_idx" ON "campaign_recipients"("contactId", "createdAt");

ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
