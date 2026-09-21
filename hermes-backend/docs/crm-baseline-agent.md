# Baseline reproducible del agente CRM

Fecha de captura: 2026-09-21, America/Guayaquil. Rama base: `main`; commit base: `5c99222` (`fix(hermes): recover coherent WhatsApp conversations`). Rama de trabajo: `feat/hermes-conversation-engine`.

## Alcance y configuración verificada

El checkout local es NestJS/TypeScript con Prisma/PostgreSQL, BullMQ/Redis y Meta Cloud API. La instalación es de una sola empresa: el esquema no incluye `tenantId` ni RLS. No debe ofrecerse como producto multiempresa aislado sin diseñar y probar ese modelo por separado.

La configuración local no secreta observada antes del cambio fue:

- endpoint compatible con OpenAI de Google: `https://generativelanguage.googleapis.com/v1beta/openai/`;
- modelo efectivo configurado: `gemini-3.8-flash`;
- razonamiento: `low`;
- versión de prompt emitida por la suite: `7d08b85a2efb`.

No se leyó, imprimió ni copió `HERMES_API_KEY`. El archivo completo `src/hermes/hermes.service.ts` tenía SHA-256 `3600C065C7C8BA673E9877F78F06E33B0583FC95E53D41E77D38F9430DCD8204` en la captura inicial; este hash sirve como evidencia del archivo, no reemplaza la versión interna del prompt.

## Recorrido real del inbound

1. `WebhookService` valida/persiste el inbound y deduplica por `Message.wamid @unique`.
2. Un `pg_advisory_xact_lock(hashtext(contactId))` serializa la creación/reapertura de conversación y evita duplicar conversaciones del contacto.
3. Respuestas de campañas hacen handoff y no entran al agente; el botón de baja actualiza el opt-out.
4. Audio recibe una respuesta de sistema y no se transcribe. Soporte, spam y solicitudes inseguras pasan por `ConversationGuardService` antes de IA.
5. `AutoReplyService.enqueue` usa `jobId=auto-reply-<inboundMessageId>` y el worker BullMQ. La cola tenía 3 intentos con backoff exponencial de 1500 ms.
6. El worker vuelve a cargar conversación/contexto canónico de PostgreSQL, descarta un turno si existe un inbound posterior y resuelve handoff/llamada antes de IA.
7. `CommercialPolicyService` calcula intención, preguntas pendientes y guardas; `HermesService` carga catálogo/documentos/playbooks aprobados y llama Gemini.
8. Después de inferencia se vuelven a comprobar estado activo e inbound más reciente. La salida pasa por política y `inspectGeneratedResponse`; precios/cotizaciones, tareas, handoff y etapas continúan bajo control determinista del CRM.
9. Meta debe devolver un `wamid`; sólo entonces se persiste el outbound. El panel humano aplica explícitamente la ventana de 24 horas para texto libre.

Existe código inalcanzable después del `return` que encola en `WebhookService`. Se documenta y no se refactoriza en esta entrega para evitar mezclar cambios.

## Baseline ejecutada antes de modificar el motor

Desde `hermes-backend`:

```text
npm test -- --runInBand
PASS: 21 suites, 210 tests, 0 snapshots (4.827 s)

npm run build
PASS

npm run test:e2e -- --runInBand
FAIL previo: 1 suite, 11 tests
```

El E2E falla durante la construcción de `RootTestModule`: `ConversationsController` ahora requiere `ConversationEventsService`, pero `test/app.e2e-spec.ts` no lo registra. `afterAll` además intenta cerrar `app` aunque la inicialización falló. Es una deuda previa independiente de la extracción del motor.

## Fixtures y controles de referencia

Los 24 casos sintéticos versionados están en `test/fixtures/conversation-engine.baseline.json`. Incluyen reparación de lavadoras/promoción, precio directo, humano, doble inbound, opt-out, ventana 24 h, precio/plazo/disponibilidad inventados, pagos, soporte, correcciones, aislamiento e inyección para obtener secretos/herramientas. No contienen PII ni llaman Meta, bases externas o el VPS.

Controles ya presentes y cubiertos por tests: handoff antes de confirmar al cliente, ninguna IA en conversación cerrada o con un inbound posterior, cuota fail-closed, bloqueo de payload estructurado, catálogo/precios autorizados, `wamid` obligatorio y persistencia de incidentes sin detalles técnicos en el texto del cliente.

## Brechas constatadas

- No hay tenant/RLS.
- La cola evita trabajos duplicados con `jobId` y PostgreSQL deduplica inbound por `wamid`, pero no existe todavía una reserva durable previa al envío a Meta que cubra el crash ambiguo «Meta aceptó, proceso cayó antes de persistir». No debe habilitarse un canary hasta decidir y probar la estrategia de reconciliación/at-most-once.
- La guarda explícita de 24 horas existe en la respuesta manual. La respuesta automática nace de un inbound recién recibido, pero no conserva una comprobación independiente de esa ventana en el instante exacto del envío.
- No existe handoff VPS local verificable. Por tanto, sólo se autorizan mocks y el motor efectivo permanece `gemini_direct`.

## Estado de implementación posterior a la captura inicial

La sección anterior conserva la fotografía previa al trabajo. En la rama
`feat/hermes-conversation-engine` ya se incorporaron, sin activar tráfico
comercial:

- reparación del módulo E2E aislado y teardown seguro;
- clasificación tipada de resultados Meta;
- ledger PostgreSQL previo al envío, reclamación atómica y estados terminales
  que impiden reenviar resultados ambiguos;
- ruta recovery-first para respuestas Hermes y avisos del webhook;
- contrato privado Nous v1 con URL y alias fijos, secreto desde archivo,
  rechazo de herramientas/contenido privilegiado y contexto stateless;
- serialización global de inferencia Nous mediante BullMQ/Redis con límite uno;
- configuración Compose de secret y red externa sólo para `app`.

Evidencia real ejecutada el 2026-09-21 en servicios desechables locales:

```text
npx prisma migrate deploy
PASS: 9 migraciones aplicadas en PostgreSQL 16 vacío

npm run test:integration
PASS: 2 suites, 2 tests, 0 snapshots (0.907 s)
```

La prueba Redis creó dos workers con concurrencia local dos y confirmó máximo
global activo uno. La prueba PostgreSQL lanzó dos reclamaciones simultáneas y
confirmó una sola transición `PREPARED` → `DISPATCHING` y una sola
`operationKey`. Los contenedores temporales fueron eliminados al terminar.

Evidencia enfocada después de implementar la cola:

```text
npm test -- --runInBand conversation-engine/nous-hermes.queue.spec.ts conversation-engine/nous-hermes.engine.spec.ts conversation-engine/conversation-engine.service.spec.ts auto-replies/auto-reply.service.spec.ts
PASS: 4 suites, 32 tests, 0 snapshots (1.873 s)

npm run build
PASS
```

Estos resultados no sustituyen la regresión completa ni una prueba conjunta
autorizada contra la VPS. `HERMES_CONVERSATION_ENGINE=gemini_direct` y la
allowlist vacía siguen siendo los valores versionados; no se realizó despliegue
ni canary real.
