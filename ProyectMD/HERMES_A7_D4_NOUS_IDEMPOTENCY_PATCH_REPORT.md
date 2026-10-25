# HERMES A7-D4 — corrección local de idempotencia Nous

## Identidad y alcance

- Base: `a7/piloto-nous-gemini-local` en `9f0ed46b58cc18df8b7f49387b56d4dbb3f47996` (tree `bccd14661b0a8c425892199c724ff0523b2fb139`).
- Rama aislada: `a7/d4-nous-idempotency-local`.
- Commit de código: `7f5d5b1cfc58eab6b7eb2d1ec3ce1e05307fa707`.
- Tree de código: `1b1870cfff89556bd86f28feeed56897f1a8fe03`.
- Estado: trabajo local. Sin push, despliegue, activación de Nous, inferencia real ni envíos Meta.

## Causa confirmada

Con F3 desactivado, `AutoReplyService` enviaba el turno normal a `NousHermesEngine` sin una reserva de generación. `NousHermesTransport` solo llamaba a `reserveNousDispatch` para el canary; fuera de él, la comprobación de una reserva previa no creaba ninguna. Si el HTTP ya había empezado y ocurría un timeout, una excepción o una caída antes de `AutomatedDeliveryService.prepareBatch`, el turno carecía de `generationReservedAt` y `providerDispatchReservedAt`. `InboundTurnService.release` podía devolverlo a `OPEN`; `InboundTurnRecoveryService` lo encolaba de nuevo. El `jobId` de BullMQ y su `removeOnComplete` no eran una reserva durable de despacho. El ledger de Meta empezaba a proteger la respuesta solo cuando ya existía un lote persistido.

El informe `HERMES_A7_D3_NOUS_REAL_WHATSAPP_SMOKE_REPORT.md` citado por el encargo no estaba presente en este workspace. La causa anterior se verificó directamente en el código y con pruebas aisladas; no se atribuyen observaciones adicionales a ese informe.

## Corrección aplicada

1. `AutoReplyService` adjunta al Nous normal el identificador del turno y su token de procesamiento. El transporte exige ese claim antes de HTTP.
2. El guard existente de `InboundTurnService.reserveNousDispatch` hace un solo `updateMany` condicional en PostgreSQL que fija fuente, token, motor y momento de despacho. El índice único de `generationSourceMessageId` y la condición `providerDispatchReservedAt: null` cierran la competencia entre workers y el replay del mismo inbound. Cada mensaje nuevo puede crear su propio turno y reserva; no existe límite por conversación.
3. El valor `nous_hermes_normal` en `generationEngine` separa las reservas normales de las del canary F3. Su motivo de bloqueo y su flujo de recuperación permanecen intactos.
4. Los fallos comprobados antes de HTTP no fijan reserva. Una respuesta o espera incierta después de iniciarlo bloquea el turno, impide otro despacho y evita enviar un texto de respaldo que pudiera duplicarse. Una admisión o espera incierta de BullMQ bloquea también un job que todavía no hubiera llegado a HTTP.
5. Una respuesta válida solo se prepara en el ledger si conserva el token original. La escritura del lote y el bloqueo se serializan sobre el turno. Si el lote ya está persistido, el flujo usa `recoverBatch` y el ledger de Meta; no vuelve a generar. Los estados `AMBIGUOUS` de Meta siguen sin reenvío automático.
6. Los turnos bloqueados crean una tarea de revisión y un handoff humano `INFO_ERROR`, sin enviar Meta. Si el proceso cae entre bloqueo y tarea, un barrido separado reintenta esa gestión de modo idempotente. Una conversación cerrada no se reabre para handoff; el veto de envío por `OPTED_OUT` sigue en el ledger.

No se añadieron campos ni migraciones. Las rutas comerciales, F4, aprendizaje, consentimiento y comprobaciones de ventana en la entrega no se cambiaron. No hay bandera nueva: el control existente de selección de motor mantiene Nous en DARK hasta el rollout autorizado.

## Archivos modificados

- `hermes-backend/src/auto-replies/auto-reply.service.ts` y `.spec.ts`.
- `hermes-backend/src/auto-replies/inbound-turn.service.ts`.
- `hermes-backend/src/auto-replies/inbound-turn-recovery.service.ts`.
- `hermes-backend/src/conversation-engine/conversation-engine.types.ts`.
- `hermes-backend/src/conversation-engine/nous-hermes.engine.ts` y `.spec.ts`.
- `hermes-backend/src/conversation-engine/nous-hermes.transport.ts` y `.spec.ts`.
- `hermes-backend/src/conversation-engine/scoped-provider-attempts.spec.ts` y `single-generation-nous.spec.ts`.
- `hermes-backend/test/f3-single-generation.integration-spec.ts` (pruebas normales y regresión F3; sin cambio de código F3/F4).

## Verificación

| Control | Resultado |
| --- | --- |
| Pruebas unitarias focalizadas | 8 suites, 261/261 pruebas aprobadas |
| PostgreSQL y Redis aislados | 4 suites, 39/39 pruebas aprobadas |
| Build Nest/TypeScript | Aprobado |
| ESLint en los 12 archivos TypeScript modificados | Aprobado |
| `prisma validate` | Aprobado |
| `git diff --check` | Aprobado |
| Migración necesaria | No |

Las pruebas cubren dos workers con una sola llamada HTTP, dos mensajes distintos en la misma conversación, asignación duplicada de inbound, fallo antes de HTTP, timeout después de la reserva, replay y recuperación de `OPEN`, job tardío tras espera incierta, lote válido persistido, rechazo de lote tardío, `MAX_TOKENS` sin texto incompleto, Meta ambiguo sin reenvío, handoff y regresión F3. Las rutas normales de política comercial y solicitud humana también pasaron en la suite de `AutoReplyService`. PostgreSQL se ejecutó en `127.0.0.1:55888` y Redis en `127.0.0.1:56379`, separados de producción. No se realizó limpieza Docker.

## Riesgos residuales y condiciones para A7-D3

- La garantía es **a lo sumo un despacho HTTP local a Nous por inbound** en workers que ejecuten este commit. No afirma ejecución externa exactly-once: el servicio Nous o su agente podrían reintentar internamente y no se verificó un contrato de idempotencia externo.
- Si un resultado válido se pierde antes de persistir el lote, el turno se bloquea y pasa a un humano; no se reconstruye automáticamente esa respuesta. Esto preserva la ausencia de duplicados frente a un resultado externo desconocido.
- Antes del despliegue, actualizar API y workers juntos, sin versiones anteriores procesando jobs de Nous. Reconciliar jobs antiguos sin claim y turnos pendientes; mantener Nous DARK mientras se valida esa transición. No borrar reservas históricas.
- Repetir A7-D3 solo con autorización de smoke y rollout: comprobar F3 OFF, dos mensajes reales distintos en una conversación, webhook repetido, reserva y handoff en fallos controlados, ventana WhatsApp, opt-out/consentimiento aplicable, ledger de Meta y ausencia de doble respuesta. Verificar el contrato de reintentos internos de Nous antes de prometer idempotencia extremo a extremo.
