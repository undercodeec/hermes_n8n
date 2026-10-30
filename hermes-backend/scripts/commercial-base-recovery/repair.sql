-- Standalone, selective repair. Review preflight first; run only on the approved DB.
-- This script does not apply the Black Friday migration or activate its offer.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(20261030, 1);
LOCK TABLE products, price_lists IN SHARE ROW EXCLUSIVE MODE;

DO $repair$
BEGIN
  IF EXISTS (SELECT 1 FROM products WHERE "sku" = 'commercial-landing-basic' AND "id" <> 'commercial-product-landing-basic') THEN
    RAISE EXCEPTION 'BASE_CATALOG_CONFLICT: SKU belongs to another product';
  END IF;
  IF EXISTS (SELECT 1 FROM products p WHERE p."id" = 'commercial-product-landing-basic'
    AND ROW(p."name", p."description", p."category", p."serviceCode", p."sku", p."imageUrl", p."isActive", p."metadata"->'commercialTerms')
      IS DISTINCT FROM ROW('Landing Básica', 'Landing page de una sola sección.', 'Landing Page', 'LANDING_PAGE', 'commercial-landing-basic', NULL::text, true,
        '{"renewalUsdPerYear":40,"estimatedBusinessDays":10}'::jsonb)) THEN
    RAISE EXCEPTION 'BASE_CATALOG_CONFLICT: product fields differ from versioned source';
  END IF;
  IF EXISTS (SELECT 1 FROM price_lists p WHERE p."id" = 'commercial-price-landing-basic-global-v1'
    AND (ROW(p."productId", p."name", p."price", p."currency", p."market", p."priceType", p."taxMode", p."taxLabel", p."taxRatePercent", p."scope", p."policyVersion", p."isPromotion", p."supersedesPriceListId", p."validUntil", p."restrictions", p."notes", p."isActive")
      IS DISTINCT FROM ROW('commercial-product-landing-basic', 'Tarifa global vigente', 250.00::numeric, 'USD', NULL::"CommercialMarket", 'FIXED'::"CommercialPriceType", 'INCLUDED'::"CommercialTaxMode", 'IVA', NULL::numeric,
        'Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por un año, cinco correos corporativos, SEO técnico base y un mes de soporte.',
        'global-v1', false, NULL::text, NULL::timestamp, NULL::text, 'Precio confirmado para Hermes.', true)
      OR p."validFrom" > clock_timestamp())) THEN
    RAISE EXCEPTION 'BASE_CATALOG_CONFLICT: tariff fields differ from versioned source';
  END IF;
  IF EXISTS (SELECT 1 FROM price_lists p WHERE p."id" <> 'commercial-price-landing-basic-global-v1'
    AND p."productId" = 'commercial-product-landing-basic' AND p."market" IS NULL
    AND p."policyVersion" = 'global-v1' AND p."isPromotion" = false) THEN
    RAISE EXCEPTION 'BASE_CATALOG_CONFLICT: another global-v1 tariff exists for this product';
  END IF;
  IF EXISTS (SELECT 1 FROM price_lists p WHERE p."id" = 'commercial-price-landing-black-friday-80-global-v1'
    AND (p."productId" <> 'commercial-product-landing-basic' OR p."supersedesPriceListId" IS DISTINCT FROM 'commercial-price-landing-basic-global-v1' OR p."isActive" = true)) THEN
    RAISE EXCEPTION 'BASE_CATALOG_CONFLICT: campaign row is incompatible or active';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM products WHERE "id" = 'commercial-product-landing-basic') THEN
    INSERT INTO products ("id", "name", "description", "category", "serviceCode", "sku", "imageUrl", "isActive", "metadata", "createdAt", "updatedAt")
    VALUES ('commercial-product-landing-basic', 'Landing Básica', 'Landing page de una sola sección.', 'Landing Page', 'LANDING_PAGE', 'commercial-landing-basic', NULL, true,
      '{"commercialTerms":{"renewalUsdPerYear":40,"estimatedBusinessDays":10}}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM price_lists WHERE "id" = 'commercial-price-landing-basic-global-v1') THEN
    INSERT INTO price_lists ("id", "productId", "name", "price", "currency", "market", "priceType", "taxMode", "taxLabel", "taxRatePercent", "scope", "policyVersion", "isPromotion", "supersedesPriceListId", "validFrom", "validUntil", "restrictions", "notes", "isActive", "createdAt", "updatedAt")
    VALUES ('commercial-price-landing-basic-global-v1', 'commercial-product-landing-basic', 'Tarifa global vigente', 250.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL,
      'Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por un año, cinco correos corporativos, SEO técnico base y un mes de soporte.',
      'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM products p JOIN price_lists t ON t."productId" = p."id"
    WHERE p."id" = 'commercial-product-landing-basic' AND t."id" = 'commercial-price-landing-basic-global-v1'
      AND p."sku" = 'commercial-landing-basic' AND p."isActive" = true
      AND t."price" = 250.00 AND t."currency" = 'USD' AND t."isActive" = true) THEN
    RAISE EXCEPTION 'BASE_CATALOG_CONFLICT: postcondition failed';
  END IF;
END
$repair$;
COMMIT;
