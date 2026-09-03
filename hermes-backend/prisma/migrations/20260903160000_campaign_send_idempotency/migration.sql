-- Persist the single-send claim before calling Meta. A retry may only reclaim
-- a recipient after an explicit Meta 429 response; ambiguous outcomes remain
-- failed for manual reconciliation rather than risking a duplicate template.
ALTER TABLE "campaign_recipients" ADD COLUMN "sendAttemptedAt" TIMESTAMP(3);
