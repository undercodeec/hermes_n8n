ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'PAYMENT_PENDING';
ALTER TYPE "LeadStage" ADD VALUE IF NOT EXISTS 'PAYMENT_REVIEW';
ALTER TYPE "TaskType" ADD VALUE IF NOT EXISTS 'PAYMENT_VERIFICATION';

CREATE TYPE "BankAccountType" AS ENUM ('SAVINGS', 'CHECKING', 'OTHER');
CREATE TYPE "TransferPaymentStatus" AS ENUM ('INSTRUCTIONS_PREPARED', 'INSTRUCTIONS_SENT', 'PROOF_RECEIVED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "bank_accounts" (
  "id" TEXT NOT NULL, "label" TEXT NOT NULL, "bankName" TEXT NOT NULL,
  "accountHolder" TEXT NOT NULL, "holderIdentification" TEXT,
  "accountType" "BankAccountType" NOT NULL, "accountNumberEncrypted" TEXT NOT NULL,
  "accountNumberLast4" TEXT NOT NULL, "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "instructions" TEXT, "priority" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true, "createdByUserId" TEXT,
  "updatedByUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bank_accounts_currency_isActive_priority_idx" ON "bank_accounts"("currency", "isActive", "priority");
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "transfer_payments" (
  "id" TEXT NOT NULL, "leadId" TEXT NOT NULL, "conversationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL, "bankAccountId" TEXT NOT NULL,
  "bankAccountSnapshot" JSONB NOT NULL, "amountExpected" DECIMAL(18,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL, "status" "TransferPaymentStatus" NOT NULL DEFAULT 'INSTRUCTIONS_PREPARED',
  "sourceMessageId" TEXT NOT NULL, "instructionsMessageId" TEXT,
  "reviewedProofMessageId" TEXT, "proofReceivedAt" TIMESTAMP(3),
  "reviewStartedAt" TIMESTAMP(3), "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3), "approvedByUserId" TEXT,
  "rejectedByUserId" TEXT, "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transfer_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "transfer_payments_sourceMessageId_key" ON "transfer_payments"("sourceMessageId");
CREATE INDEX "transfer_payments_status_createdAt_idx" ON "transfer_payments"("status", "createdAt");
CREATE INDEX "transfer_payments_leadId_createdAt_idx" ON "transfer_payments"("leadId", "createdAt");
CREATE INDEX "transfer_payments_conversationId_createdAt_idx" ON "transfer_payments"("conversationId", "createdAt");
CREATE UNIQUE INDEX "transfer_payments_one_open" ON "transfer_payments"("conversationId") WHERE "status" IN ('INSTRUCTIONS_PREPARED', 'INSTRUCTIONS_SENT', 'PROOF_RECEIVED', 'UNDER_REVIEW');
ALTER TABLE "transfer_payments" ADD CONSTRAINT "transfer_payments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfer_payments" ADD CONSTRAINT "transfer_payments_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfer_payments" ADD CONSTRAINT "transfer_payments_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfer_payments" ADD CONSTRAINT "transfer_payments_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfer_payments" ADD CONSTRAINT "transfer_payments_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transfer_payments" ADD CONSTRAINT "transfer_payments_rejectedByUserId_fkey" FOREIGN KEY ("rejectedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "transfer_payment_proof_messages" (
  "messageId" TEXT NOT NULL, "transferPaymentId" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transfer_payment_proof_messages_pkey" PRIMARY KEY ("messageId")
);
CREATE INDEX "transfer_payment_proof_messages_transferPaymentId_receivedAt_idx" ON "transfer_payment_proof_messages"("transferPaymentId", "receivedAt");
ALTER TABLE "transfer_payment_proof_messages" ADD CONSTRAINT "transfer_payment_proof_messages_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transfer_payment_proof_messages" ADD CONSTRAINT "transfer_payment_proof_messages_transferPaymentId_fkey" FOREIGN KEY ("transferPaymentId") REFERENCES "transfer_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
