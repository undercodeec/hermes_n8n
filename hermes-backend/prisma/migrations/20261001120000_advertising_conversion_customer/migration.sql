-- Conversion owner is intentionally independent of the reporting account and
-- login customer. Existing rows remain NULL until explicitly configured.
ALTER TABLE "advertising_integrations"
ADD COLUMN "conversionCustomerId" TEXT;
