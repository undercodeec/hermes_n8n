-- Reusable WhatsApp video assets. Media IDs are stored in the database, never in .env.
CREATE TABLE "campaign_media" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "metaMediaId" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_media_metaMediaId_key" ON "campaign_media"("metaMediaId");
CREATE INDEX "campaign_media_createdAt_idx" ON "campaign_media"("createdAt");

ALTER TABLE "campaigns" ADD COLUMN "headerVideoAssetId" TEXT;
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_headerVideoAssetId_fkey"
  FOREIGN KEY ("headerVideoAssetId") REFERENCES "campaign_media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
