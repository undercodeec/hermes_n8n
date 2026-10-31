-- The campaign has two confirmed markets: EUR 80 in Spain and USD 80 in Ecuador.
-- Preserve the operator's current activation state for both offers.
INSERT INTO "price_lists" (
  "id", "productId", "name", "price", "currency", "market", "priceType",
  "taxMode", "taxLabel", "taxRatePercent", "scope", "policyVersion",
  "isPromotion", "supersedesPriceListId", "validFrom", "validUntil",
  "restrictions", "notes", "isActive", "createdAt", "updatedAt"
)
SELECT
  'commercial-price-landing-black-friday-80-es-v1',
  usd."productId", usd."name", 80.00, 'EUR', 'ES', usd."priceType",
  usd."taxMode", usd."taxLabel", usd."taxRatePercent", usd."scope",
  usd."policyVersion", true, usd."supersedesPriceListId",
  usd."validFrom", usd."validUntil", usd."restrictions",
  'Promoción Black Friday para España. Activar o desactivar mediante isActive.',
  usd."isActive", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "price_lists" AS usd
WHERE usd."id" = 'commercial-price-landing-black-friday-80-global-v1'
  AND usd."currency" = 'USD'
  AND usd."price" = 80.00
  AND usd."policyVersion" = 'black-friday-landing-80-v1'
ON CONFLICT ("id") DO NOTHING;

UPDATE "price_lists"
SET "market" = 'EC', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'commercial-price-landing-black-friday-80-global-v1'
  AND "currency" = 'USD'
  AND "price" = 80.00
  AND "policyVersion" = 'black-friday-landing-80-v1'
  AND "market" IS NULL;
