CREATE TYPE "InboundTurnStatus" AS ENUM ('OPEN', 'PROCESSING', 'PROCESSED');

CREATE TABLE "inbound_turns" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "firstAt" TIMESTAMP(3) NOT NULL,
  "lastAt" TIMESTAMP(3) NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "lastMessageId" TEXT NOT NULL,
  "status" "InboundTurnStatus" NOT NULL DEFAULT 'OPEN',
  "processingAt" TIMESTAMP(3),
  "processingToken" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inbound_turns_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "messages" ADD COLUMN "inboundTurnId" TEXT;
ALTER TABLE "messages" ADD COLUMN "inboundTurnPosition" INTEGER;

CREATE INDEX "inbound_turns_conversationId_status_dueAt_idx"
  ON "inbound_turns"("conversationId", "status", "dueAt");
CREATE INDEX "messages_inboundTurnId_createdAt_idx"
  ON "messages"("inboundTurnId", "createdAt");
CREATE UNIQUE INDEX "messages_inboundTurnId_inboundTurnPosition_key"
  ON "messages"("inboundTurnId", "inboundTurnPosition");

ALTER TABLE "inbound_turns"
  ADD CONSTRAINT "inbound_turns_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_inboundTurnId_fkey"
  FOREIGN KEY ("inboundTurnId") REFERENCES "inbound_turns"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
