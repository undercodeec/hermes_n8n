-- Operational terms belong to the product tier, not to the price list.
-- Preserve any existing product metadata.
UPDATE "products"
SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
  'commercialTerms', jsonb_build_object(
    'renewalUsdPerYear', CASE WHEN "sku" IN (
      'commercial-landing-premium', 'commercial-website-authority', 'commercial-store-elite'
    ) THEN 80 ELSE 40 END,
    'estimatedBusinessDays', CASE WHEN "sku" IN (
      'commercial-landing-basic', 'commercial-website-launch', 'commercial-store-launch'
    ) THEN 10 ELSE 20 END
  )
),
"updatedAt" = CURRENT_TIMESTAMP
WHERE "sku" IN (
  'commercial-landing-basic', 'commercial-landing-pro', 'commercial-landing-premium',
  'commercial-website-launch', 'commercial-website-growth', 'commercial-website-authority',
  'commercial-store-launch', 'commercial-store-growth', 'commercial-store-elite'
);

INSERT INTO "knowledge_documents" (
  "id", "title", "content", "type", "version", "tags", "isActive", "createdAt", "updatedAt"
) VALUES (
  'commercial-delivery-policy-v1',
  'Plazos comerciales estimados',
  'Los planes básicos tienen un plazo estimado de aproximadamente 10 días laborables. Los planes superiores tienen un plazo estimado de aproximadamente 20 días laborables. Software a medida, aplicaciones web o móviles y Moodle requieren valoración y un mínimo aproximado de 30 días laborables. El plazo depende de que el cliente entregue oportunamente textos, imágenes, logotipo, productos, accesos y demás material necesario; si se retrasa la entrega, el plazo se desplaza. No prometer una fecha fija sin validación humana.',
  'POLICY', 1, '["timeline","delivery"]'::jsonb, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
) ON CONFLICT ("id") DO NOTHING;
