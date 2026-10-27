# HERMES A7-D13 — continuación durable local de MONITOR_ONLY

Fecha: 26/10/2026. Dictamen: **READY_FOR_GIT_REVIEW**. Este dictamen habilita únicamente la revisión del código local; no acredita capacidad productiva, activación de Nous ni política aprobada de retención.

## A. Estado inicial

- Worktree: `D:\Documentos\Hermes\.worktrees\a7-d12-monitor-only-20261026`.
- Rama: `pilot/a7-d12-monitor-only-20261026`.
- Base y HEAD al comenzar: `370f5f97498ef2bad7bdc5ea69e01d19c667b76b`; tree base `38122690531d66385ca91ce50da8ca7ba0e9e0b3`.
- Se leyeron la auditoría A7-D11, el informe A7-D12, el código modificado y los contratos de webhook, colas, reserva de inferencia y entregas. Los cambios sin commit de A7-D12 se conservaron y ampliaron en el mismo worktree. No se tocó `main`.

## B. Causa raíz y recorrido real

`WebhookController.receive` persiste el evento en el inbox y responde sin esperar a Nous. `WebhookService.routeInbound` encola `AutoReplyService` mediante BullMQ. El worker `AutoReplyProcessor` reclama el `InboundTurn`; `AutoReplyService.processTurn` selecciona motor y `NousHermesEngine.respond` encola `nous-${inboundMessageId}`. `NousHermesProcessor` ejecuta `NousHermesTransport`; este reserva el despacho en PostgreSQL antes de HTTP. Después se validan la respuesta comercial, la conversación y el lote en `AutomatedDeliveryService`, que reclama y entrega a Meta con ledger idempotente.

La descripción A7-D12 de una conexión HTTP del webhook retenida fue imprecisa: la espera sin límite de ventanas estaba dentro del worker de autorespuestas. Al vencer una ventana de 120 segundos con el worker Nous ausente, A7-D12 repetía `waitUntilFinished` sobre el mismo job. Si se perdía al llamador del worker, BullMQ podía completar y eliminar el resultado sin una continuación capaz de preparar y entregar el mensaje. La recuperación anterior bloqueaba una reserva de generación antigua tras 15 minutos; no sabía distinguir un job aún pendiente de un resultado aprovechable.

## C. Solución implementada

- `InboundTurn` conserva la identidad original del inbound, marca de admisión a Nous, marca de desacoplamiento y resultado estructurado exitoso (máximo 64 KB). La migración nueva agrega cuatro columnas anulables e índice; no crea tabla ni cola. Los turnos previos son compatibles porque los campos nuevos aceptan `NULL`.
- `NousHermesEngine` registra la admisión antes de `queue.add`, espera una sola ventana acotada y desacopla trabajos `waiting`, `delayed` o `active` recientes. No genera un segundo job. Ante un resultado ya persistido, incluso si se perdió la notificación o la clave temporal BullMQ, lee PostgreSQL. BullMQ vuelve a `removeOnComplete:true`.
- `NousHermesProcessor` persiste el resultado original antes de confirmar el job. La escritura comprueba token de procesamiento, origen, reserva de proveedor y estado bajo bloqueo de fila. Una persistencia fallida impide confirmar el resultado del worker.
- `AutoReplyService` libera el worker de autorespuestas cuando Nous sigue pendiente sin perder el token del despacho. Al reanudar, lee el resultado original sin otra inferencia ni otro débito de cuota y pasa de nuevo por política, validación comercial, comprobación de handoff, preparación y ledger Meta. `InboundTurnRecoveryService` reencola la autorespuesta tras un resultado durable; si el job sigue pendiente, lo observa sin reenviarlo; si falta o terminó sin resultado durable, bloquea y solicita revisión humana.
- Archivos principales: `prisma/schema.prisma`, `prisma/migrations/20261026190000_nous_durable_continuation/migration.sql`, `src/auto-replies/{auto-reply.service.ts,auto-reply.module.ts,inbound-turn.service.ts,inbound-turn-recovery.service.ts}`, `src/conversation-engine/{nous-hermes.engine.ts,nous-hermes.processor.ts}`, pruebas focales e integradas, y la sección 0 del runbook. Los demás cambios A7-D12 de política comercial y pruebas permanecen incluidos.

## D. Seguridad y operación

La reserva única PostgreSQL y el `jobId` derivado del inbound mantienen una sola inferencia lógica. Un proveedor incierto, trabajo perdido, ejecución activa demasiado antigua o resultado sin escritura durable queda bloqueado para revisión; no se reenvía a ciegas. Los resultados tardíos atraviesan el control de conversación activa, handoff, inbound más reciente y ledger. Un lote ya confirmado no vuelve a enviarse. `NOUS_PILOT_OPERATIONS_ENABLED=false` sigue impidiendo nuevas entradas y el reclamo de una respuesta Nous preparada; las reservas y entregas existentes no se borran. El trabajo ya iniciado se concilia según el contrato previo. Los umbrales de 80 solicitudes, USD 4 y cinco pendientes solo alertan en MONITOR_ONLY; ENFORCE mantiene las cuotas. F3/F4, Meta Ads y Nous Agent A7-D8 no se modificaron.

## E. Evidencia de pruebas

| Verificación | Resultado |
|---|---|
| Unitarias focales de motor, procesador y autorespuesta durable | PASS, 4 suites / 180 casos. Incluyen admisión fallida, escritura fallida, notificación perdida, parada y handoff. |
| Suite unitaria completa | PASS, 94 suites / 1528 casos. Preserva umbrales A7-D12 44/100/101, USD 4/5, cola 5/10/20, ENFORCE y configuración inválida. |
| PostgreSQL 16 y Redis 7 aislados | PASS, 2 suites / 31 casos, con las 26 migraciones aplicadas desde una base vacía. Incluye reserva única, webhook/job duplicado, timeout, resultado tardío, recuperación y ledger con Meta simulado. |
| Caída de worker mayor que espera configurada | PASS: ventana de 100 ms y ausencia adicional de 250 ms; el primer llamador sale, el job original sigue `waiting`, y al reiniciar se procesa una sola vez. El lease de 15 minutos se simuló mediante timestamps atrasados; no se esperaron 15 minutos reales. |
| Build y tipos del backend (`tsconfig.build.json`), ESLint focal, `git diff --check`, dependencias productivas | PASS; auditoría npm: 0 vulnerabilidades de nivel high o superior. |

Las pruebas locales usaron puertos de loopback `55432` y `56379`, proveedor Nous y Meta simulados. A7-D12 reportó 5 suites / 64 pruebas focales, 9 / 458 de regresión y 2 / 27 de integración; A7-D13 ejecutó toda la suite unitaria y añadió cuatro casos integrados netos. La prueba sintética de 20 conversaciones y la de caída no demuestran rendimiento ni continuidad ilimitada durante siete días.

## F. Deuda heredada, secretos y retención

- TypeScript global `tsconfig.json`: R3 base 143 diagnósticos, worktree 140; comparación normalizada por archivo, código y mensaje: **cero diagnósticos nuevos** y dos clases únicas menos. Los restantes pertenecen a pruebas heredadas fuera del alcance; el backend afectado compila y pasa lint.
- `npm run security:secrets` conserva cuatro hallazgos idénticos a A7-D12. `docker-compose.learning-test.yml:10`: contraseña estática de base aislada de pruebas, **valor de prueba no sensible**. `scripts/evaluate-f3-shadow.mjs:23` y `scripts/run-learning-integration.mjs:6`: URL con credencial de prueba y host loopback, **valores de prueba no sensibles**. `src/scripts/evaluate-f2-provider.ts:183`: `HERMES_API_KEY: key` pasa una variable, no contiene literal, **falso positivo demostrado**. No se imprimen los valores en este informe ni se halló un secreto real nuevo.
- El resultado estructurado añade una copia temporal en PostgreSQL mientras el turno esté pendiente; se elimina al completar o bloquear. No se guarda una conversación completa adicional. Redis ya no necesita retener resultados completados. La duración de turnos pendientes y la política integral de privacidad/retención siguen abiertas; no se declara cumplimiento legal.
- La migración solo se aplicó a una base local efímera. Para revertir en un entorno futuro: detener nuevas admisiones, conciliar trabajos y entregas en vuelo, desactivar operaciones y volver a ENFORCE mediante configuración controlada. Conservar las columnas hasta cerrar pendientes; retirarlas exigiría otra migración aprobada. No se improvisó reversión productiva.

## G. Preparación para Git

Rama y worktree originales conservados. La referencia Git final y su tree se obtienen de `git rev-parse HEAD` y `git rev-parse HEAD^{tree}` tras el cierre local; el corte base figura en A. El diff comprende los archivos A7-D12 preservados, los cambios A7-D13 enumerados en C y este informe. No hubo push, merge, PR, despliegue, migración productiva, activación Nous, envío WhatsApp, inferencia facturable ni modificación de campañas.

## H. Dictamen

**READY_FOR_GIT_REVIEW** para revisión local del conjunto A7-D12/A7-D13. La espera del worker quedó acotada y una respuesta original completada puede recuperarse desde PostgreSQL y pasar una sola vez por las barreras de entrega. Siguen pendientes la revisión humana del cambio, la política de retención y la medición operativa antes de cualquier decisión de publicación o activación.
