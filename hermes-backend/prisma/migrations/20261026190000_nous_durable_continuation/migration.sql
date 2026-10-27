ALTER TABLE "inbound_turns"
  ADD COLUMN "nousQueuedAt" TIMESTAMP(3),
  ADD COLUMN "nousDetachedAt" TIMESTAMP(3),
  ADD COLUMN "nousResult" JSONB,
  ADD COLUMN "nousResultAt" TIMESTAMP(3);

CREATE INDEX "inbound_turns_status_processingAt_nousQueuedAt_idx"
  ON "inbound_turns"("status", "processingAt", "nousQueuedAt");
