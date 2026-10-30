-- Read-only postcondition. Any mismatch exits nonzero with ON_ERROR_STOP=1.
BEGIN READ ONLY;
DO $verify$
BEGIN
  IF (SELECT count(*) FROM products WHERE "id" = 'commercial-product-landing-basic') <> 1
    OR (SELECT count(*) FROM price_lists WHERE "id" = 'commercial-price-landing-basic-global-v1') <> 1
    OR EXISTS (SELECT 1 FROM products WHERE "sku" = 'commercial-landing-basic' AND "id" <> 'commercial-product-landing-basic')
    OR EXISTS (SELECT 1 FROM price_lists p WHERE p."id" <> 'commercial-price-landing-basic-global-v1'
      AND p."productId" = 'commercial-product-landing-basic' AND p."market" IS NULL AND p."policyVersion" = 'global-v1' AND p."isPromotion" = false)
    OR NOT EXISTS (SELECT 1 FROM products p JOIN price_lists t ON t."productId" = p."id"
      WHERE p."id" = 'commercial-product-landing-basic' AND t."id" = 'commercial-price-landing-basic-global-v1'
        AND ROW(p."name", p."description", p."category", p."serviceCode", p."sku", p."imageUrl", p."isActive", p."metadata"->'commercialTerms')
          IS NOT DISTINCT FROM ROW('Landing Básica', 'Landing page de una sola sección.', 'Landing Page', 'LANDING_PAGE', 'commercial-landing-basic', NULL::text, true,
            '{"renewalUsdPerYear":40,"estimatedBusinessDays":10}'::jsonb)
        AND ROW(t."name", t."price", t."currency", t."market", t."priceType", t."taxMode", t."taxLabel", t."taxRatePercent", t."scope", t."policyVersion", t."isPromotion", t."supersedesPriceListId", t."validUntil", t."restrictions", t."notes", t."isActive")
          IS NOT DISTINCT FROM ROW('Tarifa global vigente', 250.00::numeric, 'USD', NULL::"CommercialMarket", 'FIXED'::"CommercialPriceType", 'INCLUDED'::"CommercialTaxMode", 'IVA', NULL::numeric,
            'Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por un año, cinco correos corporativos, SEO técnico base y un mes de soporte.',
            'global-v1', false, NULL::text, NULL::timestamp, NULL::text, 'Precio confirmado para Hermes.', true)
        AND t."validFrom" <= CURRENT_TIMESTAMP) THEN
    RAISE EXCEPTION 'BASE_CATALOG_CONFLICT: postcheck failed';
  END IF;
END
$verify$;
SELECT 'BASE_CATALOG_ALREADY_VALID';
COMMIT;
