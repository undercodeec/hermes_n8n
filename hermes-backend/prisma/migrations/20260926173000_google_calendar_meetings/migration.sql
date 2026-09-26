CREATE TYPE "MeetingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED');
CREATE TYPE "MeetingOperationKind" AS ENUM ('CREATE', 'RESCHEDULE', 'CANCEL');
CREATE TYPE "MeetingOperationStatus" AS ENUM ('PREPARED', 'APPLYING', 'RETRY', 'COMPLETED', 'FAILED');
ALTER TABLE "conversation_states" ADD COLUMN "meetingState" JSONB;
CREATE TABLE "meetings" (
 "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "contactId" TEXT NOT NULL,
 "leadId" TEXT, "taskId" TEXT, "provider" TEXT NOT NULL DEFAULT 'GOOGLE',
 "googleEventId" TEXT NOT NULL, "calendarId" TEXT NOT NULL, "meetUrl" TEXT,
 "attendeeEmail" TEXT NOT NULL, "startAt" TIMESTAMP(3) NOT NULL, "endAt" TIMESTAMP(3) NOT NULL,
 "timezone" TEXT NOT NULL, "status" "MeetingStatus" NOT NULL DEFAULT 'PENDING',
 "idempotencyKey" TEXT NOT NULL, "serviceContext" TEXT, "cancelledAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "meetings_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "meetings_time_check" CHECK ("endAt" > "startAt")
);
CREATE TABLE "meeting_operations" (
 "id" TEXT NOT NULL, "meetingId" TEXT NOT NULL, "operationKey" TEXT NOT NULL,
 "sourceMessageId" TEXT NOT NULL, "kind" "MeetingOperationKind" NOT NULL,
 "status" "MeetingOperationStatus" NOT NULL DEFAULT 'PREPARED',
 "targetStartAt" TIMESTAMP(3) NOT NULL, "targetEndAt" TIMESTAMP(3) NOT NULL,
 "claimToken" TEXT, "claimExpiresAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
 "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "meeting_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meetings_taskId_key" ON "meetings"("taskId");
CREATE UNIQUE INDEX "meetings_idempotencyKey_key" ON "meetings"("idempotencyKey");
CREATE UNIQUE INDEX "meetings_calendarId_googleEventId_key" ON "meetings"("calendarId", "googleEventId");
CREATE INDEX "meetings_conversationId_status_startAt_idx" ON "meetings"("conversationId", "status", "startAt");
CREATE INDEX "meetings_calendarId_status_startAt_endAt_idx" ON "meetings"("calendarId", "status", "startAt", "endAt");
CREATE UNIQUE INDEX "meeting_operations_operationKey_key" ON "meeting_operations"("operationKey");
CREATE INDEX "meeting_operations_status_claimExpiresAt_idx" ON "meeting_operations"("status", "claimExpiresAt");
-- Only one unresolved mutation per event. Claims are fenced by claimToken.
CREATE UNIQUE INDEX "meeting_operations_one_active" ON "meeting_operations"("meetingId") WHERE "status" IN ('PREPARED', 'APPLYING', 'RETRY');
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meeting_operations" ADD CONSTRAINT "meeting_operations_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
