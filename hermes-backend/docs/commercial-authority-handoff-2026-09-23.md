# Autoridad comercial global de Hermes

## Fuente operativa

`Product` y `PriceList` de PostgreSQL son la única fuente de precios de Hermes. La migración `20260923020000_seed_global_commercial_prices` carga nueve planes globales, en USD e IVA incluido. Una tarifa con `market = NULL` aplica igual para Ecuador, España y cualquier otro mercado; Hermes no convierte la moneda ni solicita país para comunicarla.

El worker consulta `PriceList` cada vez que prepara una respuesta. Por ello, un administrador puede actualizar el importe, alcance, vigencia, impuesto o estado mediante `PUT /api/price-lists/:id`; el siguiente mensaje de Hermes usa el valor actualizado. No hay caché de precios ni sincronización con una página externa.

| Categoría | Plan | Precio global |
| --- | --- | ---: |
| Landing Page | Landing Básica | USD 250.00 |
| Landing Page | Landing Pro | USD 600.00 |
| Landing Page | Landing Premium | USD 1,500.00 |
| Sitio Web | Plan de Lanzamiento | USD 360.00 |
| Sitio Web | Plan de Crecimiento | USD 510.00 |
| Sitio Web | Plan de Autoridad | USD 1,010.00 |
| Tienda Online | Tienda de Lanzamiento | USD 550.00 |
| Tienda Online | Tienda de Crecimiento | USD 850.00 |
| Tienda Online | Tienda Élite | USD 3,490.00 |

Cada fila usa `FIXED`, `USD`, `INCLUDED`, `IVA`, `global-v1`, sin promoción ni fecha de vencimiento. El alcance de cada plan queda en `PriceList.scope` y también se entrega a Hermes como contexto autorizado cuando es pertinente.

## Flujo de Hermes

`AutoReplyService` obtiene una instantánea comercial al recibir un mensaje y la entrega a Nous o Gemini. `reviewCommercialClaims` conserva afirmaciones compatibles con esa instantánea y elimina importes, moneda, IVA o promociones no autorizados. `answerExplicitPriceIfMissing` solo completa un importe cuando el cliente preguntó directamente por el precio y hay una sola oferta aplicable; una recomendación no recibe precios insertados automáticamente.

Las tarifas específicas por mercado siguen siendo compatibles para una necesidad futura. Si existieran, tienen prioridad sobre la tarifa global únicamente para ese mercado. Si no hay tarifa global y el precio depende de mercado, Hermes pide una sola aclaración breve.

El catálogo estático `commercial-catalog.ts` queda como artefacto de reversión. No autoriza precios ni se usa como alternativa automática cuando PostgreSQL no tiene una tarifa válida.

## Migración

Ejecutar en el entorno de destino, después de respaldar PostgreSQL:

```powershell
cd hermes-backend
npx prisma migrate deploy
```

La migración previa añade los campos de política comercial. La segunda crea o actualiza los nueve productos por SKU e inserta sus tarifas globales una sola vez. No se desplegó la aplicación ni se accedió a una VPS desde este trabajo.

## Verificación

Las pruebas cubren precio global sin país, el mismo importe USD para una consulta de España, prioridad de tarifa de mercado cuando exista, vigencia, promociones, `FIXED`, `FROM`, `QUOTE_REQUIRED`, IVA, importes no autorizados y respuestas que no necesitan precios. Una prueba también cambia el importe de la fuente simulada entre dos consultas y confirma que Hermes lee el valor vigente en ambas.
