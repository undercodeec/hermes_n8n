# Informe de implementación: Black Friday Landing Page USD $80

Fecha: 29 de octubre de 2026. Rama: `feat/nous-black-friday-landing-80`. Base: `origin/main` (`50c3d0f`). Alcance: desarrollo local; sin acceso a producción ni despliegue.

## Arquitectura y regla comercial

Se reutiliza `Product` y `PriceList` del CRM. La nueva tarifa promocional global de USD $80 enlaza con la tarifa base de Landing Básica por `supersedesPriceListId`. La autoridad comercial consulta únicamente tarifas activas y vigentes; elige la promoción solo cuando el mensaje actual o el contexto reciente identifican Black Friday o la página de $80. Una consulta ordinaria de landing conserva el plan habitual. Si la promoción no está activa, la autoridad no aprueba el precio promocional e informa que un asesor debe verificar la vigencia.

La selección aprobada llega a Nous mediante `commercialSnapshotKnowledge` y `approvedContext`. Las instrucciones de campaña se agregan al prompt del motor solo si existe una oferta promocional aprobada. Una consulta general de la campaña solicita implícitamente el precio: el filtro final permite USD $80 y conserva las barreras contra otros importes. Las preguntas por un detalle deben centrarse en ese detalle; las preguntas por inclusiones piden enumerar los diez puntos. Las condiciones sin fuente confirmada se remiten a un asesor. No se heredan del producto base el precio de renovación ni el plazo de entrega.

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

Se usaron mocks y datos sintéticos. La suite completa final pasó: 63 suites y 1027 pruebas. `npm run build` pasó. ESLint sin `--fix` sobre los nueve archivos TypeScript afectados pasó. `git diff --check` pasó. `npx prisma validate` pasó con una URL local ficticia suministrada solo para satisfacer la variable obligatoria, sin conexión a base de datos.

Las pruebas cubren reconocimiento general y por precio, diez inclusiones en el conocimiento aprobado, preguntas de seguimiento y cambios de servicio, dominio/hosting/correos/SEO/WhatsApp/soporte mediante el alcance entregado a Nous, formulaciones oficiales que atraviesan el filtro de Nous, exclusión de tienda, promoción desactivada, impuestos no confirmados, conservación del plan común, audio transcrito, nombre disponible o vacío en el transporte, respuesta única y ausencia de duplicado en el envío probado. El contenido final generado por un modelo real no se evaluó; el formato y las instrucciones se verificaron con mocks.

## Riesgos y estado de publicación

- La migración depende de que exista la tarifa base `commercial-price-landing-basic-global-v1`. Si falta, el `INSERT ... SELECT` no crea la promoción; se debe verificar la fila tras migrar.
- La redacción natural de Nous depende del modelo; la prueba comprueba instrucciones y barreras comerciales, no una salida real de producción.
- La oferta permanecerá desactivada hasta que el equipo ejecute el release y la active. No se ejecutó ninguna migración sobre una base real ni se enviaron mensajes WhatsApp reales.
- La rama de funcionalidad contiene únicamente cambios de este alcance y requiere revisión, release de código/migración y activación comercial separada. No se desplegó en VPS ni se modificaron Docker, PM2 o F3/F4.
