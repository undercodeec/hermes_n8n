CREATE TYPE "FeedbackRating" AS ENUM ('GOOD', 'BAD');
CREATE TYPE "FeedbackReasonCode" AS ENUM ('REPETITION', 'WRONG_FACT', 'MISSED_INTENT', 'NO_NEXT_STEP', 'TONE', 'OTHER');

CREATE TABLE "conversation_feedback" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "rating" "FeedbackRating" NOT NULL,
  "reasonCode" "FeedbackReasonCode",
  "suggestedReply" VARCHAR(2000),
  "requestKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_feedback_requestKey_key" ON "conversation_feedback"("requestKey");
CREATE UNIQUE INDEX "conversation_feedback_messageId_userId_key" ON "conversation_feedback"("messageId", "userId");
CREATE INDEX "conversation_feedback_conversationId_createdAt_idx" ON "conversation_feedback"("conversationId", "createdAt");

ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_feedback" ADD CONSTRAINT "conversation_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
