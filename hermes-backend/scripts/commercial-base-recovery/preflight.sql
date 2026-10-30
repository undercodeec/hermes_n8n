-- Read-only classification. Run with psql -X -v ON_ERROR_STOP=1 -tA -f preflight.sql.
-- Dynamic timestamps are not compared with seed time; validFrom must be current.
WITH state AS (
  SELECT
    (SELECT count(*) FROM products WHERE "id" = 'commercial-product-landing-basic') AS product_rows,
    (SELECT count(*) FROM products WHERE "sku" = 'commercial-landing-basic' AND "id" <> 'commercial-product-landing-basic') AS sku_conflicts,
    (SELECT count(*) FROM products p WHERE p."id" = 'commercial-product-landing-basic'
      AND ROW(p."name", p."description", p."category", p."serviceCode", p."sku", p."imageUrl", p."isActive", p."metadata"->'commercialTerms')
        IS NOT DISTINCT FROM ROW('Landing Básica', 'Landing page de una sola sección.', 'Landing Page', 'LANDING_PAGE', 'commercial-landing-basic', NULL::text, true,
          '{"renewalUsdPerYear":40,"estimatedBusinessDays":10}'::jsonb)) AS valid_product_rows,
    (SELECT count(*) FROM price_lists WHERE "id" = 'commercial-price-landing-basic-global-v1') AS price_rows,
    (SELECT count(*) FROM price_lists p WHERE p."id" = 'commercial-price-landing-basic-global-v1'
      AND ROW(p."productId", p."name", p."price", p."currency", p."market", p."priceType", p."taxMode", p."taxLabel", p."taxRatePercent", p."scope", p."policyVersion", p."isPromotion", p."supersedesPriceListId", p."validUntil", p."restrictions", p."notes", p."isActive")
        IS NOT DISTINCT FROM ROW('commercial-product-landing-basic', 'Tarifa global vigente', 250.00::numeric, 'USD', NULL::"CommercialMarket", 'FIXED'::"CommercialPriceType", 'INCLUDED'::"CommercialTaxMode", 'IVA', NULL::numeric,
          'Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por un año, cinco correos corporativos, SEO técnico base y un mes de soporte.',
          'global-v1', false, NULL::text, NULL::timestamp, NULL::text, 'Precio confirmado para Hermes.', true)
      AND p."validFrom" <= CURRENT_TIMESTAMP) AS valid_price_rows,
    (SELECT count(*) FROM price_lists p WHERE p."id" <> 'commercial-price-landing-basic-global-v1'
      AND p."productId" = 'commercial-product-landing-basic' AND p."market" IS NULL
      AND p."policyVersion" = 'global-v1' AND p."isPromotion" = false) AS logical_price_conflicts,
    (SELECT count(*) FROM price_lists p WHERE p."id" = 'commercial-price-landing-black-friday-80-global-v1'
      AND (p."productId" <> 'commercial-product-landing-basic' OR p."supersedesPriceListId" IS DISTINCT FROM 'commercial-price-landing-basic-global-v1' OR p."isActive" = true)) AS campaign_conflicts
)
SELECT CASE
    WHEN sku_conflicts > 0 OR logical_price_conflicts > 0 OR campaign_conflicts > 0
      OR product_rows <> valid_product_rows OR price_rows <> valid_price_rows THEN 'BASE_CATALOG_CONFLICT'
    WHEN product_rows = 0 AND price_rows = 0 THEN 'BASE_CATALOG_MISSING'
    WHEN product_rows = 1 AND price_rows = 0 THEN 'BASE_CATALOG_PARTIAL'
    WHEN product_rows = 1 AND price_rows = 1 THEN 'BASE_CATALOG_ALREADY_VALID'
    ELSE 'BASE_CATALOG_CONFLICT'
  END AS verdict,
  product_rows, price_rows, sku_conflicts, logical_price_conflicts, campaign_conflicts
FROM state;
