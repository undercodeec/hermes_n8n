-- Explicit, additive migration. Keep this table even if the mobile endpoint is rolled back.
CREATE TYPE "MobileReplyStatus" AS ENUM ('PREPARED', 'DISPATCHING', 'CONFIRMED', 'REJECTED', 'AMBIGUOUS');

CREATE TABLE "mobile_reply_operations" (
    "operationId" UUID NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "status" "MobileReplyStatus" NOT NULL DEFAULT 'PREPARED',
    "dispatchStartedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionCode" VARCHAR(64),
    "ambiguousAt" TIMESTAMP(3),
    "wamid" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mobile_reply_operations_pkey" PRIMARY KEY ("operationId")
);

CREATE UNIQUE INDEX "mobile_reply_operations_wamid_key" ON "mobile_reply_operations"("wamid");
CREATE UNIQUE INDEX "mobile_reply_operations_messageId_key" ON "mobile_reply_operations"("messageId");
CREATE INDEX "mobile_reply_operations_conversationId_userId_createdAt_idx" ON "mobile_reply_operations"("conversationId", "userId", "createdAt");
