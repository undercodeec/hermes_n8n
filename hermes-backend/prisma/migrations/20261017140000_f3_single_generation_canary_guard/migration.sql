ALTER TYPE "InboundTurnStatus" ADD VALUE 'BLOCKED';

ALTER TABLE "inbound_turns"
  ADD COLUMN "generationSourceMessageId" TEXT,
  ADD COLUMN "generationReservedAt" TIMESTAMP(3),
  ADD COLUMN "generationToken" TEXT,
  ADD COLUMN "generationEngine" TEXT,
  ADD COLUMN "providerDispatchReservedAt" TIMESTAMP(3),
  ADD COLUMN "generationBlockedAt" TIMESTAMP(3),
  ADD COLUMN "generationBlockReason" TEXT;

CREATE UNIQUE INDEX "inbound_turns_generationSourceMessageId_key"
  ON "inbound_turns"("generationSourceMessageId");
