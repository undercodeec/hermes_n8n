-- Seed the global price policy confirmed for Hermes. A NULL market means that
-- the policy applies equally in Ecuador, Spain, and any other customer market.
-- Product IDs are stable text IDs because Prisma maps String IDs to TEXT here.

INSERT INTO "products" (
  "id", "name", "description", "category", "serviceCode", "sku",
  "isActive", "createdAt", "updatedAt"
)
VALUES
  ('commercial-product-landing-basic', 'Landing Básica', 'Landing page de una sola sección.', 'Landing Page', 'LANDING_PAGE', 'commercial-landing-basic', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-product-landing-pro', 'Landing Pro', 'Landing page para campañas y captación.', 'Landing Page', 'LANDING_PAGE', 'commercial-landing-pro', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-product-landing-premium', 'Landing Premium', 'Landing page con campaña y diseño personalizado.', 'Landing Page', 'LANDING_PAGE', 'commercial-landing-premium', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-product-website-launch', 'Plan de Lanzamiento', 'Sitio web profesional de inicio.', 'Sitio Web', 'WEBSITE', 'commercial-website-launch', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-product-website-growth', 'Plan de Crecimiento', 'Sitio web para reforzar presencia y captación.', 'Sitio Web', 'WEBSITE', 'commercial-website-growth', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-product-website-authority', 'Plan de Autoridad', 'Sitio web personalizado con automatización.', 'Sitio Web', 'WEBSITE', 'commercial-website-authority', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-product-store-launch', 'Tienda de Lanzamiento', 'Tienda online para iniciar ventas.', 'Tienda Online', 'ONLINE_STORE', 'commercial-store-launch', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-product-store-growth', 'Tienda de Crecimiento', 'Tienda online para escalar ventas.', 'Tienda Online', 'ONLINE_STORE', 'commercial-store-growth', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-product-store-elite', 'Tienda Élite', 'Tienda online de alto rendimiento.', 'Tienda Online', 'ONLINE_STORE', 'commercial-store-elite', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("sku") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "serviceCode" = EXCLUDED."serviceCode",
  "isActive" = EXCLUDED."isActive",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "price_lists" (
  "id", "productId", "name", "price", "currency", "market", "priceType",
  "taxMode", "taxLabel", "taxRatePercent", "scope", "policyVersion",
  "isPromotion", "supersedesPriceListId", "validFrom", "validUntil",
  "restrictions", "notes", "isActive", "createdAt", "updatedAt"
)
VALUES
  ('commercial-price-landing-basic-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-landing-basic'), 'Tarifa global vigente', 250.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por un año, cinco correos corporativos, SEO técnico base y un mes de soporte.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-price-landing-pro-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-landing-pro'), 'Tarifa global vigente', 600.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Incluye Landing Básica, textos persuasivos, formulario optimizado, recurso promocional, Analytics e integración con WhatsApp y respuestas iniciales.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-price-landing-premium-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-landing-premium'), 'Tarifa global vigente', 1500.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Incluye Landing Básica, palabras clave para Google, campaña de Google Ads por un mes y diseño personalizado con animaciones inmersivas.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-price-website-launch-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-website-launch'), 'Tarifa global vigente', 360.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Hasta cinco páginas, diseño profesional adaptable, dominio .com y hosting por un año, SSL, hasta cinco correos corporativos, formulario y WhatsApp, configuración inicial en Google y un mes de soporte.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-price-website-growth-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-website-growth'), 'Tarifa global vigente', 510.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Incluye el Plan de Lanzamiento y añade hasta ocho páginas, textos persuasivos, optimización de velocidad, posicionamiento local, Analytics y Search Console, integraciones y tres meses de soporte.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-price-website-authority-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-website-authority'), 'Tarifa global vigente', 1010.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Incluye el Plan de Crecimiento y añade diseño totalmente personalizado, automatización con IA, sistemas avanzados a medida, seguridad reforzada, campaña de Google Ads por un mes, seguimiento y soporte VIP por seis meses.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-price-store-launch-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-store-launch'), 'Tarifa global vigente', 550.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Catálogo administrable, carga inicial de hasta 20 productos, carrito y pago seguro, dominio .com, hosting y SSL por un año, diseño adaptable, configuración de envíos, configuración inicial en Google, cinco correos corporativos, capacitación para gestionar la tienda y un mes de soporte técnico.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-price-store-growth-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-store-growth'), 'Tarifa global vigente', 850.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Incluye Tienda de Lanzamiento, filtros avanzados, SEO técnico avanzado, recuperación de carritos abandonados, inventario en tiempo real, estrategia de envíos por zonas y condiciones, y tres meses de soporte técnico.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commercial-price-store-elite-global-v1', (SELECT "id" FROM "products" WHERE "sku" = 'commercial-store-elite'), 'Tarifa global vigente', 3490.00, 'USD', NULL, 'FIXED', 'INCLUDED', 'IVA', NULL, 'Incluye Tienda de Crecimiento, tecnología ultra rápida, conexión con sistemas empresariales, recomendador con IA, ventas internacionales, automatización de marketing, facturación electrónica, seguridad reforzada, respaldos automáticos y soporte VIP por seis meses.', 'global-v1', false, NULL, CURRENT_TIMESTAMP, NULL, NULL, 'Precio confirmado para Hermes.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
