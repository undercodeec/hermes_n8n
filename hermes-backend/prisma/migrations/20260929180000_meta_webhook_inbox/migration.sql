CREATE TYPE "MetaWebhookInboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "meta_webhook_inbox" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "MetaWebhookInboxStatus" NOT NULL DEFAULT 'PENDING',
  "outcome" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "meta_webhook_inbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_webhook_inbox_eventKey_key" ON "meta_webhook_inbox"("eventKey");
CREATE INDEX "meta_webhook_inbox_status_leaseUntil_createdAt_idx" ON "meta_webhook_inbox"("status", "leaseUntil", "createdAt");
