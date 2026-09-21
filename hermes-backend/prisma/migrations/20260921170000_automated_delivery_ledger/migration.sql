CREATE TYPE "AutomatedDeliveryKind" AS ENUM ('HERMES_REPLY', 'SYSTEM_NOTICE');
CREATE TYPE "AutomatedDeliveryStatus" AS ENUM (
  'PREPARED', 'DISPATCHING', 'CONFIRMED', 'REJECTED', 'AMBIGUOUS', 'SUPPRESSED'
);

CREATE TABLE "automated_deliveries" (
  "id" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "deliveryKind" "AutomatedDeliveryKind" NOT NULL,
  "partIndex" INTEGER NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "outboundMessageId" TEXT,
  "sender" "MessageSender" NOT NULL,
  "content" TEXT NOT NULL,
  "allowHandedOff" BOOLEAN NOT NULL DEFAULT false,
  "status" "AutomatedDeliveryStatus" NOT NULL DEFAULT 'PREPARED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimToken" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "dispatchStartedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "ambiguousAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "suppressedAt" TIMESTAMP(3),
  "wamid" TEXT,
  "reasonCode" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automated_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automated_deliveries_operationKey_key"
  ON "automated_deliveries"("operationKey");
CREATE UNIQUE INDEX "automated_deliveries_outboundMessageId_key"
  ON "automated_deliveries"("outboundMessageId");
CREATE UNIQUE INDEX "automated_deliveries_wamid_key"
  ON "automated_deliveries"("wamid");
CREATE UNIQUE INDEX "automated_deliveries_sourceMessageId_deliveryKind_partIndex_key"
  ON "automated_deliveries"("sourceMessageId", "deliveryKind", "partIndex");
CREATE INDEX "automated_deliveries_status_claimExpiresAt_idx"
  ON "automated_deliveries"("status", "claimExpiresAt");
CREATE INDEX "automated_deliveries_conversationId_createdAt_idx"
  ON "automated_deliveries"("conversationId", "createdAt");

ALTER TABLE "automated_deliveries"
  ADD CONSTRAINT "automated_deliveries_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automated_deliveries"
  ADD CONSTRAINT "automated_deliveries_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "contacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automated_deliveries"
  ADD CONSTRAINT "automated_deliveries_sourceMessageId_fkey"
  FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automated_deliveries"
  ADD CONSTRAINT "automated_deliveries_outboundMessageId_fkey"
  FOREIGN KEY ("outboundMessageId") REFERENCES "messages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
