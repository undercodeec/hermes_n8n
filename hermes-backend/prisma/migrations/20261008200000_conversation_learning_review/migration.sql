CREATE TYPE "ConversationReviewTrigger" AS ENUM ('BAD_FEEDBACK', 'INCIDENT');
CREATE TYPE "ConversationReviewStatus" AS ENUM ('PENDING', 'PROCESSING', 'NO_LEARNING', 'PROPOSED', 'FAILED');
CREATE TYPE "LearningItemStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED');
CREATE TYPE "LearningRiskLevel" AS ENUM ('LOW', 'NEEDS_REVIEW', 'HIGH');

CREATE TABLE "conversation_reviews" (
  "id" TEXT NOT NULL,
  "reviewKey" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "feedbackId" TEXT,
  "reviewerVersion" TEXT NOT NULL,
  "trigger" "ConversationReviewTrigger" NOT NULL,
  "status" "ConversationReviewStatus" NOT NULL DEFAULT 'PENDING',
  "issueCode" VARCHAR(60),
  "summary" VARCHAR(500),
  "counterexample" VARCHAR(500),
  "confidence" DOUBLE PRECISION,
  "providerModel" VARCHAR(100),
  "processingAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "conversation_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "learning_items" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "LearningItemStatus" NOT NULL DEFAULT 'PROPOSED',
  "kind" VARCHAR(60) NOT NULL,
  "trigger" VARCHAR(200) NOT NULL,
  "guidance" VARCHAR(500) NOT NULL,
  "serviceCode" VARCHAR(60),
  "market" VARCHAR(60),
  "riskLevel" "LearningRiskLevel" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "validUntil" TIMESTAMP(3),
  "sourceReviewId" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "learning_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "learning_evidence" (
  "id" TEXT NOT NULL,
  "learningItemId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId" TEXT,
  "feedbackId" TEXT,
  "reviewId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "learning_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_reviews_reviewKey_key" ON "conversation_reviews"("reviewKey");
CREATE INDEX "conversation_reviews_status_createdAt_idx" ON "conversation_reviews"("status", "createdAt");
CREATE INDEX "conversation_reviews_conversationId_createdAt_idx" ON "conversation_reviews"("conversationId", "createdAt");
CREATE UNIQUE INDEX "learning_items_fingerprint_version_key" ON "learning_items"("fingerprint", "version");
CREATE INDEX "learning_items_status_serviceCode_market_validUntil_idx" ON "learning_items"("status", "serviceCode", "market", "validUntil");
CREATE UNIQUE INDEX "learning_evidence_learningItemId_conversationId_key" ON "learning_evidence"("learningItemId", "conversationId");
CREATE INDEX "learning_evidence_conversationId_createdAt_idx" ON "learning_evidence"("conversationId", "createdAt");

ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_reviews" ADD CONSTRAINT "conversation_reviews_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "conversation_feedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_sourceReviewId_fkey" FOREIGN KEY ("sourceReviewId") REFERENCES "conversation_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "learning_items" ADD CONSTRAINT "learning_items_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_learningItemId_fkey" FOREIGN KEY ("learningItemId") REFERENCES "learning_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "conversation_feedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "learning_evidence" ADD CONSTRAINT "learning_evidence_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "conversation_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;
