# Informe de implementación: Black Friday Landing Page USD $80

Fecha: 30 de octubre de 2026. Rama: `feat/nous-black-friday-landing-80-pilot`. Base: `origin/pilot/a7-d12-monitor-only-20261026` (`1fa0e13ba46e72949797c283fab554d93d1aa1d3`). Commit de integración: `4a4e39d`. Alcance: desarrollo local; sin acceso a producción ni despliegue. La implementación original `6fb5e120a372a6291b0761dccecf1bbdc9beca08` estaba basada en un `main` divergente; se integró sobre la línea piloto que ya contiene Audio Inbox y el fallback humanizado.

## Arquitectura y regla comercial

Se reutiliza `Product` y `PriceList` del CRM. La nueva tarifa promocional global de USD $80 enlaza con la tarifa base de Landing Básica por `supersedesPriceListId`. La autoridad comercial consulta únicamente tarifas activas y vigentes; elige la promoción solo cuando el mensaje actual o el contexto reciente identifican Black Friday o la página de $80. Una consulta ordinaria de landing conserva el plan habitual. Si la promoción no está activa, la autoridad no aprueba el precio promocional e informa que un asesor debe verificar la vigencia.

La selección aprobada llega a Nous mediante `commercialSnapshotKnowledge` y `approvedContext`. Las instrucciones de campaña se agregan al prompt del motor solo si existe una oferta promocional aprobada. Una consulta general de la campaña solicita implícitamente el precio: el filtro final permite USD $80 y conserva las barreras contra otros importes. Las preguntas por un detalle deben centrarse en ese detalle; las preguntas por inclusiones piden enumerar los diez puntos. Las condiciones sin fuente confirmada se remiten a un asesor. No se heredan del producto base el precio de renovación ni el plazo de entrega; una consulta de plazo de Black Friday tampoco incorpora la política general de diez días laborables. Si también existe una tarifa normal específica del mercado, la promoción global autorizada conserva precedencia únicamente para la consulta de campaña.

## Diez características confirmadas

1. Captación de leads, sin cantidad ni conversión garantizada.
2. Landing page de una sola sección.
3. Diseño responsive para celulares.
4. Botón flotante de WhatsApp y llamada directa.
5. Formulario de contacto o captura de prospectos.
6. Apartado de beneficios del servicio o producto.
7. Dominio .com y hosting básico por un año.
8. Cinco correos corporativos.
9. SEO técnico base, sin garantizar posicionamiento.
10. Un mes de soporte posterior a la entrega.

La tarifa no autoriza tienda online, plazos, revisiones, condiciones de pago, impuestos incluidos o excluidos, fecha de cierre, renovaciones posteriores ni resultados garantizados.

## Reconocimiento y vigencia

`recognizesBlackFridayLanding` detecta menciones explícitas de Black Friday, página/landing de $80 y preguntas de seguimiento en el historial reciente disponible del cliente. Un cambio posterior a tienda online u otro servicio explícito rompe ese seguimiento. Un presupuesto de $80 o una cantidad de 80 páginas no se interpretan como la oferta. La clasificación se aplica al texto consolidado de WhatsApp, por lo que también procesa audios transcritos correctamente.

La migración `20261029200000_black_friday_landing_80` crea la tarifa con `isActive=false`, `validUntil=NULL` y sin modalidad fiscal definida. Tras el procedimiento de release y la revisión comercial correspondiente, un operador autenticado puede activar la fila `commercial-price-landing-black-friday-80-global-v1` mediante `PUT /api/price-lists/:id` con `{"isActive":true}`. Para finalizar la campaña, usar el mismo endpoint con `{"isActive":false}`. Si se confirma una fecha de caducidad, puede configurarse `validUntil`; el filtro de autoridad la respeta. No se fijó una fecha ficticia.

## Archivos

- `hermes-backend/prisma/migrations/20261029200000_black_friday_landing_80/migration.sql`: tarifa promocional inactiva, vinculada a la base.
- `hermes-backend/src/hermes/black-friday-landing.ts`: reconocimiento acotado e identificación de consultas generales.
- `hermes-backend/src/hermes/commercial-authority.service.ts`: selección de oferta aprobada, aislamiento del plan habitual y conocimiento comercial.
- `hermes-backend/src/auto-replies/auto-reply.service.ts`: habilitación del precio confirmado para consultas generales activas.
- `hermes-backend/src/conversation-engine/nous-hermes.transport.ts`: instrucciones condicionales de respuesta.
- Nuevas pruebas: `black-friday-landing.spec.ts`, `black-friday-landing-migration.spec.ts`, `commercial-black-friday.spec.ts`; pruebas ampliadas de `auto-reply.service.spec.ts` y `nous-hermes.transport.spec.ts`.
- `hermes-backend/docs/superpowers/plans/2026-10-29-black-friday-landing-80.md`: plan y trazabilidad local.

## Verificación

Se usaron mocks y datos sintéticos. La suite completa sobre la línea piloto integrada pasó: **101 suites y 1619 pruebas**. `npm run build` pasó. ESLint sin `--fix` sobre los archivos TypeScript afectados pasó tras aplicar Prettier. `git diff --cached --check` pasó antes del commit. `npx prisma validate` pasó con una URL local ficticia suministrada solo para satisfacer la variable obligatoria, sin conexión a base de datos.

Las pruebas cubren reconocimiento general y por precio, diez inclusiones en el conocimiento aprobado, preguntas de seguimiento y cambios de servicio, dominio/hosting/correos/SEO/WhatsApp/soporte mediante el alcance entregado a Nous, formulaciones oficiales que atraviesan el filtro de Nous, exclusión de tienda incluso cuando se menciona Black Friday, promoción desactivada, impuestos no confirmados, exclusión del plazo normal de diez días para la campaña, conservación del plan común, coexistencia con una tarifa normal específica de Ecuador, audio transcrito, nombre disponible o vacío en el transporte, respuesta única y ausencia de duplicado en el envío probado. El contenido final generado por un modelo real no se evaluó; el formato y las instrucciones se verificaron con mocks.

## Estado Git y publicación

La implementación se integró en `feat/nous-black-friday-landing-80-pilot` sobre el commit piloto `1fa0e13ba46e72949797c283fab554d93d1aa1d3`. El commit inicial de código es `4a4e39d`; la revisión local identificó y se corrigieron dos casos: cambio explícito a tienda online y filtración del plazo de entrega habitual. La rama se publica en `origin/feat/nous-black-friday-landing-80-pilot`. El paso posterior requiere el procedimiento de release de código y migración, verificación de la fila CRM y activación comercial separada; ningún paso de producción forma parte de esta publicación.

## Riesgos

- La migración depende de que exista la tarifa base `commercial-price-landing-basic-global-v1`. Si falta, el `INSERT ... SELECT` no crea la promoción; se debe verificar la fila tras migrar.
- La redacción natural de Nous depende del modelo; la prueba comprueba instrucciones y barreras comerciales, no una salida real de producción.
- La oferta permanecerá desactivada hasta que el equipo ejecute el release y la active. No se ejecutó ninguna migración sobre una base real ni se enviaron mensajes WhatsApp reales.
- La rama de funcionalidad contiene únicamente cambios de este alcance sobre `pilot`. La promoción permanece inactiva en la migración. No se desplegó en VPS ni se modificaron Docker, PM2 o F3/F4.
