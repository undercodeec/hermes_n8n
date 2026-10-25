ALTER TABLE "inbound_turns" ADD COLUMN "canaryRunId" UUID;
CREATE UNIQUE INDEX "inbound_turns_canaryRunId_key" ON "inbound_turns"("canaryRunId");
