ALTER TABLE "campaigns" ADD COLUMN "templateMetaId" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "templateHeaderType" TEXT;

CREATE TABLE "campaign_template_media" (
  "id" TEXT NOT NULL,
  "wabaId" TEXT NOT NULL,
  "metaTemplateId" TEXT,
  "templateName" TEXT NOT NULL,
  "templateLanguage" TEXT NOT NULL,
  "headerType" TEXT NOT NULL,
  "campaignMediaId" TEXT,
  "mediaUrl" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_template_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_template_media_wabaId_templateName_templateLanguage_headerType_key"
  ON "campaign_template_media"("wabaId", "templateName", "templateLanguage", "headerType");
CREATE INDEX "campaign_template_media_metaTemplateId_idx"
  ON "campaign_template_media"("metaTemplateId");

ALTER TABLE "campaign_template_media" ADD CONSTRAINT "campaign_template_media_campaignMediaId_fkey"
  FOREIGN KEY ("campaignMediaId") REFERENCES "campaign_media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
