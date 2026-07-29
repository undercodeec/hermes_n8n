-- Associate each lead with its primary conversation and distinguish message authors.
CREATE TYPE "MessageSender" AS ENUM ('CONTACT', 'HERMES', 'HUMAN', 'SYSTEM');

ALTER TABLE "leads" ADD COLUMN "conversationId" TEXT;
ALTER TABLE "messages" ADD COLUMN "sender" "MessageSender" NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "messages" ADD COLUMN "sentByUserId" TEXT;

-- Preserve the best available attribution for historical records.
UPDATE "messages"
SET "sender" = CASE
  WHEN "direction" = 'INBOUND' THEN 'CONTACT'::"MessageSender"
  ELSE 'HERMES'::"MessageSender"
END;

-- Attach existing leads to the most recently updated conversation for their contact.
UPDATE "leads" AS l
SET "conversationId" = (
  SELECT c.id
  FROM "conversations" AS c
  WHERE c."contactId" = l."contactId"
  ORDER BY c."updatedAt" DESC
  LIMIT 1
)
WHERE l."conversationId" IS NULL
  AND l.id = (
    SELECT newest_lead.id
    FROM "leads" AS newest_lead
    WHERE newest_lead."contactId" = l."contactId"
    ORDER BY newest_lead."createdAt" DESC
    LIMIT 1
  )
  AND EXISTS (
    SELECT 1
    FROM "conversations" AS c
    WHERE c."contactId" = l."contactId"
  );

CREATE UNIQUE INDEX "leads_conversationId_key" ON "leads"("conversationId");
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "leads"
    WHERE "stage" NOT IN ('WON', 'LOST')
    GROUP BY "contactId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'CRM migration aborted: a contact has more than one open lead';
  END IF;
END
$$;
CREATE UNIQUE INDEX "leads_one_open_per_contact_idx"
ON "leads"("contactId")
WHERE "stage" NOT IN ('WON', 'LOST');
CREATE INDEX "leads_contactId_createdAt_idx" ON "leads"("contactId", "createdAt");
CREATE INDEX "leads_stage_updatedAt_idx" ON "leads"("stage", "updatedAt");
CREATE INDEX "conversations_contactId_updatedAt_idx" ON "conversations"("contactId", "updatedAt");
CREATE INDEX "conversations_status_updatedAt_idx" ON "conversations"("status", "updatedAt");
CREATE INDEX "messages_sentByUserId_idx" ON "messages"("sentByUserId");
CREATE INDEX "human_handoffs_conversationId_status_idx" ON "human_handoffs"("conversationId", "status");
CREATE INDEX "human_handoffs_status_createdAt_idx" ON "human_handoffs"("status", "createdAt");

ALTER TABLE "leads"
ADD CONSTRAINT "leads_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "messages"
ADD CONSTRAINT "messages_sentByUserId_fkey"
FOREIGN KEY ("sentByUserId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
