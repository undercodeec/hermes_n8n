-- Stage the confirmed Black Friday landing offer without activating it.
-- Operators control the campaign with price_lists.isActive; no end date or tax
-- treatment has been confirmed. The existing Landing Básica remains the base.
INSERT INTO "price_lists" (
  "id", "productId", "name", "price", "currency", "market", "priceType",
  "taxMode", "taxLabel", "taxRatePercent", "scope", "policyVersion",
  "isPromotion", "supersedesPriceListId", "validFrom", "validUntil",
  "restrictions", "notes", "isActive", "createdAt", "updatedAt"
)
SELECT
  'commercial-price-landing-black-friday-80-global-v1',
  base."productId",
  'Black Friday — Landing Page',
  80.00, 'USD', NULL, 'FIXED',
  NULL, NULL, NULL,
  'Captación de leads; landing page de una sola sección; diseño responsive para celulares; botón flotante de WhatsApp y llamada directa; formulario de contacto o captura de prospectos; apartado de beneficios del servicio o producto; dominio .com y hosting básico por 1 año; 5 correos corporativos; SEO técnico base; 1 mes de soporte posterior a la entrega.',
  'black-friday-landing-80-v1',
  true, base."id", CURRENT_TIMESTAMP, NULL,
  'No incluye tienda online. Impuestos, tiempo de entrega, condiciones de pago, renovaciones posteriores y condiciones de soporte adicionales requieren confirmación.',
  'Promoción temporal. Activar o desactivar mediante isActive; no inventar fecha de cierre.',
  false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "price_lists" AS base
WHERE base."id" = 'commercial-price-landing-basic-global-v1'
  AND base."market" IS NULL
  AND base."isPromotion" = false
ON CONFLICT ("id") DO NOTHING;
