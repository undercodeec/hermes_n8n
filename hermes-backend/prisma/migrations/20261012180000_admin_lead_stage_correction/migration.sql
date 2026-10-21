-- Keep historical qualification events while allowing a new, independently
-- idempotent event after an audited administrative correction.
ALTER TABLE "advertising_conversions"
  ADD COLUMN "qualificationCycle" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "invalidatedAt" TIMESTAMP(3),
  ADD COLUMN "invalidationReason" TEXT;

DROP INDEX "advertising_conversions_leadId_eventType_key";
CREATE UNIQUE INDEX "advertising_conversions_leadId_eventType_qualificationCycle_key"
  ON "advertising_conversions"("leadId", "eventType", "qualificationCycle");

CREATE TABLE "lead_stage_corrections" (
  "id" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "previousStage" "LeadStage" NOT NULL,
  "targetStage" "LeadStage" NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "advertisingReconciliation" TEXT NOT NULL,
  "advertisingSyncJobId" TEXT,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_stage_corrections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_stage_corrections_requestKey_key"
  ON "lead_stage_corrections"("requestKey");
CREATE INDEX "lead_stage_corrections_leadId_createdAt_idx"
  ON "lead_stage_corrections"("leadId", "createdAt");
