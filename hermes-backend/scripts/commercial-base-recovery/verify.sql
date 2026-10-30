-- Read-only postcondition. Any mismatch exits nonzero with ON_ERROR_STOP=1.
BEGIN READ ONLY;
DO $verify$
BEGIN
  IF (SELECT count(*) FROM products WHERE "id" = 'commercial-product-landing-basic') <> 1
    OR (SELECT count(*) FROM price_lists WHERE "id" = 'commercial-price-landing-basic-global-v1') <> 1
    OR EXISTS (SELECT 1 FROM products WHERE "sku" = 'commercial-landing-basic' AND "id" <> 'commercial-product-landing-basic')
    OR EXISTS (SELECT 1 FROM price_lists p WHERE p."id" <> 'commercial-price-landing-basic-global-v1'
      AND p."productId" = 'commercial-product-landing-basic' AND p."market" IS NULL AND p."policyVersion" = 'global-v1' AND p."isPromotion" = false)
    OR EXISTS (SELECT 1 FROM price_lists p WHERE p."id" = 'commercial-price-landing-black-friday-80-global-v1'
      AND (ROW(p."productId", p."name", p."price", p."currency", p."market", p."priceType", p."taxMode", p."taxLabel", p."taxRatePercent", p."scope", p."policyVersion", p."isPromotion", p."supersedesPriceListId", p."validUntil", p."restrictions", p."notes", p."isActive")
        IS DISTINCT FROM ROW('commercial-product-landing-basic', 'Black Friday — Landing Page', 80.00::numeric, 'USD', NULL::"CommercialMarket", 'FIXED'::"CommercialPriceType", NULL::"CommercialTaxMode", NULL::text, NULL::numeric,
          'Captación de leads; landing page de una sola sección; diseño responsive para celulares; botón flotante de WhatsApp y llamada directa; formulario de contacto o captura de prospectos; apartado de beneficios del servicio o producto; dominio .com y hosting básico por 1 año; 5 correos corporativos; SEO técnico base; 1 mes de soporte posterior a la entrega.',
          'black-friday-landing-80-v1', true, 'commercial-price-landing-basic-global-v1', NULL::timestamp,
          'No incluye tienda online. Impuestos, tiempo de entrega, condiciones de pago, renovaciones posteriores y condiciones de soporte adicionales requieren confirmación.',
          'Promoción temporal. Activar o desactivar mediante isActive; no inventar fecha de cierre.', false)
        OR p."validFrom" > CURRENT_TIMESTAMP))
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
