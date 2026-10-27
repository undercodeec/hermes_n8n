# HERMES A7-D12 — implementación local MONITOR_ONLY

Fecha: 26/10/2026. Dictamen: **BLOCKED** para revisión de publicación. Este informe describe solo el worktree local; Nous comercial, F3 y F4 siguen sin activarse.

## A. Identidad

| Campo | Valor |
|---|---|
| Rama | `pilot/a7-d12-monitor-only-20261026` |
| Worktree | `D:\Documentos\Hermes\.worktrees\a7-d12-monitor-only-20261026` |
| Commit base y HEAD | `370f5f97498ef2bad7bdc5ea69e01d19c667b76b` (A7-D10-R3) |
| Tree Git base | `38122690531d66385ca91ce50da8ca7ba0e9e0b3` |
| Commit final local | Ninguno: el dictamen y las validaciones globales pendientes impiden darlo por cerrado. |
| Estado | Archivos A7-D12 modificados sin commit en el worktree aislado. El `main` existente y sus cambios previos no se tocaron. |

La auditoría obligatoria `HERMES_A7_D11_BUDGET_LIMITS_READ_ONLY_AUDIT_REPORT.md` se leyó antes de editar. El corte R3 y el tree se verificaron. El runbook local conserva la actualización Markdown del paquete 26/10, cuya versión se contrastó antes de incorporarla.

## B. Cambios implementados

| Archivo | Función | Antes | Ahora y razón |
|---|---|---|---|
| `src/conversation-engine/nous-pilot-budget.policy.ts` | `nousPilotBudgetMode` | Sin modo explícito. | Acepta únicamente `MONITOR_ONLY`; ausencia o valor inválido equivalen a `ENFORCE` para preservar la conducta anterior. |
| `src/conversation-engine/nous-hermes.transport.ts` | `pilotBlockCode`, `execute`, `logPilotDispatch` | Prechequeo de 100 solicitudes/USD 5 y dependencia de lectura de cuota; las alertas se emitían por cada solicitud tras el umbral. | En MONITOR_ONLY omite solo cuotas comerciales; mantiene interruptores y reserva durable. Lecturas posteriores de métricas son de mejor esfuerzo. Registra reservas UTC, estimación o `null`, `billedUsd:null`, y alertas periódicas por solicitudes y cruce de múltiplos de USD 4. |
| `src/auto-replies/inbound-turn.service.ts` | `reserveNousDispatch` | La transacción PostgreSQL imponía las cuotas para Nous normal. | MONITOR_ONLY usa la misma reclamación condicional atómica del inbound sin condiciones de cuota; ENFORCE conserva la transacción y el bloqueo asesor. |
| `src/conversation-engine/nous-hermes.engine.ts` | `respond` | Cinco trabajos pendientes bloqueaban; una espera vencida bloqueaba el resultado aunque el trabajo original siguiera en cola. | Cinco pendientes alertan en MONITOR_ONLY. Se vuelve a esperar **el mismo** trabajo si sigue pendiente o acaba de activarse; un activo antiguo, fallo o estado incierto mantiene el bloqueo ambiguo. Se conservan temporalmente resultados completos para recuperar un evento perdido y se registran tiempos agregados de cola. |
| `.env.example` | Contrato de configuración | Sin política de modo. | Añade `NOUS_PILOT_BUDGET_MODE=ENFORCE`, explica su semántica y los umbrales informativos; el flag comercial permanece apagado. |
| `docs/undercodeec-pilot-runbook.md` | Sección A7-D12 | Describía R6 y el comportamiento histórico. | Añade modo, umbrales, continuidad de cola, límites, reversión y deuda de privacidad sin borrar el historial. |
| Cinco archivos de pruebas unitarias/integración | Casos nuevos | Sin pruebas del modo. | Añaden umbrales 44/100/101, USD 4/5, configuración inválida, fallos de observabilidad, cola 5/10/20, concurrencia PostgreSQL y reinicio sintético del worker. Un fixture heredado recibió `contactName` para satisfacer su DTO. |

No se modificó Nous Agent A7-D8, el esquema/migraciones, los DTO de campañas, los servicios de Meta Ads ni las rutas de despliegue.

## C. Matriz de controles

| Mecanismo | ENFORCE | MONITOR_ONLY |
|---|---|---|
| Límite diario de solicitudes Nous y USD estimados | ENFORCED | MONITORING_ONLY |
| Umbrales de 80 solicitudes, USD 4 y cinco trabajos pendientes | ALERT_ONLY | ALERT_ONLY |
| Estimación monetaria; `billedUsd:null` | MONITORING_ONLY | MONITORING_ONLY |
| Reclamación durable por inbound, identidad del trabajo y bloqueo ambiguo | SAFETY_GUARD | SAFETY_GUARD |
| Firma/número Meta, deduplicación `wamid`, selección fija de motor, validación de salida, control comercial y entregas idempotentes | SAFETY_GUARD | SAFETY_GUARD |
| Parada `NOUS_PILOT_OPERATIONS_ENABLED` y autorización comercial separada | ENFORCED | ENFORCED |
| Límite técnico por ejecución del agente A7-D8 | ENFORCED | ENFORCED |
| F3/F4 y operación comercial efectiva en este corte DARK | DISABLED | DISABLED |
| Facturación real, capacidad sostenida de siete días y retención aprobada | UNKNOWN | UNKNOWN |

La reclamación PostgreSQL sigue siendo requisito de despacho; un fallo de esa escritura no se trata como fallo de una métrica.

## D. Pruebas y calidad

| Verificación | Resultado |
|---|---|
| Unitarias focalizadas de política, transporte, reserva y cola | **PASS**, 5 suites / 64 pruebas, incluido el comportamiento heredado de ENFORCE ante un fallo de métricas. |
| Regresión de motor, Gemini Direct, validación, autorespuesta, entrega, webhook, Meta Ads y política comercial | **PASS**, 9 suites / 458 pruebas con proveedores simulados. |
| Integración PostgreSQL y Redis aislados | **PASS**, 2 suites / 27 pruebas; incluyen carrera de dos reservas sobre un inbound y 20 trabajos con concurrencia uno, espera de varias ventanas y reinicio del worker. Los 20 devolvieron su resultado original, sin segunda inferencia sintética. |
| Build y tipado del backend (`tsconfig.build.json`) | **PASS**. |
| Prettier, ESLint focal y `git diff --check` | **PASS**. |
| `npm audit --omit=dev --audit-level=high` | **PASS**, 0 vulnerabilidades reportadas. No se modificaron dependencias. |
| Chequeo global `tsconfig.json` | **FAIL**, 140 errores en archivos de pruebas ajenos a A7-D12; ningún error en los archivos modificados. Los tres errores preexistentes del fixture F3 modificado se corrigieron localmente. |
| `npm run security:secrets` | **FAIL**, cuatro hallazgos preexistentes y sin cambios en `docker-compose.learning-test.yml`, `scripts/evaluate-f3-shadow.mjs`, `scripts/run-learning-integration.mjs` y `src/scripts/evaluate-f2-provider.ts`. No se introdujeron credenciales en los archivos A7-D12. |

Se usaron PostgreSQL y Redis locales de `docker-compose.learning-test.yml`, en el proyecto `hermes-a7d12-test` y puertos `127.0.0.1:55432`/`56379`; no hubo llamadas reales a Gemini, Nous, Meta o WhatsApp. Una interrupción temporal de Docker causó una repetición fallida por infraestructura; al recuperarse, la repetición final de las 27 pruebas pasó. Las pruebas sintéticas comprueban 1, 5, 10 y 20 trabajos; no certifican capacidad productiva.

## E. Riesgos y capacidad

1. **STOP por continuidad sostenida.** Con un worker ausente, un trabajo puede permanecer `waiting` mientras el llamador mantiene una espera síncrona sin límite de ventanas. Con latencias reales y 20 o más trabajos, el tiempo total puede superar el timeout HTTP aguas arriba. Un reinicio breve pasó la prueba sintética, pero no demuestra entrega continua ni handoff correcto durante una caída larga. La solución siguiente requiere una continuación durable desacoplada del request HTTP, recuperando el mismo job, con entrega WhatsApp y conciliación idempotentes. No se implementó esa modificación arquitectónica en A7-D12.
2. El trabajo `active` que excede su ventana conserva el bloqueo ambiguo y puede exigir revisión humana; los errores de proveedor o entrega conservan sus rutas de seguridad. No se presupone concurrencia ilimitada; worker y agente permanecen en concurrencia uno.
3. La retención temporal de resultados BullMQ (`age=300`, `count=100`) evita perder una finalización por notificación tardía, pero Redis limpia por edad al producirse otras finalizaciones. Puede conservar payload/resultados más de cinco minutos. La política integral de privacidad y retención sigue sin aprobarse.
4. Las reservas PostgreSQL son el contador durable. Las alertas se generan desde lecturas posteriores de mejor esfuerzo y pueden omitirse si falla la observabilidad o si varias reservas concurrentes saltan un punto exacto de cruce. El total acumulado puede derivarse de reservas, pero no existe aún una serie acumulada dedicada. El tiempo de cola se registra para trabajos completados; la latencia exclusiva del proveedor y el desglose de tokens conocidos dependen de la telemetría/uso existente y no se certificaron extremo a extremo.
5. USD 0.116122 por solicitud es solo un coeficiente estimado. `billedUsd:null` no concilia facturas de IA, WhatsApp ni Meta Ads.
6. El espacio local observado en `D:` fue aproximadamente 125 GiB libres. No se inspeccionó la VPS en esta tarea. El runbook R6 histórico cita 6 GB/89 % al cierre de ese corte; ese dato no acredita espacio disponible hoy para un despliegue posterior.

## F. Compatibilidad

- **Meta Ads:** no hay diff en campañas, Ads Manager, atribución ni presupuesto publicitario; su suite seleccionada pasó. Los umbrales Nous se aplican solo a `assignedEngine='nous_hermes'`.
- **Gemini Direct y conversaciones existentes:** el selector, el motor persistido y Gemini Direct no se editaron; sus pruebas de regresión pasaron. El modo no asigna un motor a conversaciones nuevas por sí solo.
- **Nous Agent A7-D8:** no se editó. Permanecen sus límites técnicos y el contrato privado; las pruebas locales no sustituyen una certificación del agente real.
- **F3/F4:** no se activaron; las rutas canary y sus estados ambiguos pasaron integración focal. El fixture preexistente solo recibió un campo DTO requerido.
- **Webhook, ledger WhatsApp y parada:** no se cambiaron; pasaron las pruebas seleccionadas de firma/número, autorespuesta, entrega idempotente e interruptores. No se enviaron mensajes.
- **Idempotencia:** la carrera PostgreSQL otorgó exactamente una reserva; la cola de 20 completó cada inbound una vez sin reencolarlo. La ejecución prolongada con caída del worker aún no está demostrada.

## G. Dictamen y siguiente paso

**BLOCKED / STOP.** El código local cumple los escenarios focales y conserva las protecciones verificadas, pero la espera síncrona sin worker, la retención pendiente de aprobación y las validaciones globales heredadas impiden afirmar continuidad comercial de siete días o emitir `READY_FOR_GIT_REVIEW`. No se creó commit, push, PR, merge ni despliegue. La siguiente revisión debe definir y probar la continuación durable después de un timeout HTTP, cerrar la política de retención aplicable y clasificar/corregir las fallas globales de tipos y secretos antes de decidir publicación. La activación comercial requeriría una decisión posterior distinta.
