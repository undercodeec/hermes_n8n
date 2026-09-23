-- Add market and policy metadata without assigning authority to legacy prices.
CREATE TYPE "CommercialMarket" AS ENUM ('EC', 'ES');
CREATE TYPE "CommercialPriceType" AS ENUM ('FIXED', 'FROM', 'QUOTE_REQUIRED');
CREATE TYPE "CommercialTaxMode" AS ENUM ('INCLUDED', 'EXCLUDED', 'NOT_APPLICABLE');

ALTER TABLE "products" ADD COLUMN "serviceCode" TEXT;
CREATE INDEX "products_serviceCode_isActive_idx" ON "products"("serviceCode", "isActive");

ALTER TABLE "price_lists"
  ALTER COLUMN "price" TYPE DECIMAL(12,2) USING ROUND("price"::numeric, 2),
  ALTER COLUMN "price" DROP NOT NULL,
  ADD COLUMN "market" "CommercialMarket",
  ADD COLUMN "priceType" "CommercialPriceType",
  ADD COLUMN "taxMode" "CommercialTaxMode",
  ADD COLUMN "taxLabel" TEXT,
  ADD COLUMN "taxRatePercent" DECIMAL(5,2),
  ADD COLUMN "scope" TEXT,
  ADD COLUMN "policyVersion" TEXT,
  ADD COLUMN "isPromotion" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "supersedesPriceListId" TEXT;

CREATE INDEX "price_lists_market_isActive_validFrom_validUntil_idx"
  ON "price_lists"("market", "isActive", "validFrom", "validUntil");
