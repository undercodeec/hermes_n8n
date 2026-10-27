# Piloto comercial UnderCodeEC — runbook actualizado a R6 (26/10/2026)

> **CORTE DOCUMENTAL: 26/10/2026.** Preparado a partir de fuentes Markdown aportadas y reportes de Codex, no de una inspección nueva en vivo. **Este archivo descargable no está integrado por sí mismo en Git, en la VPS ni en el CRM.** Conserva debajo la versión histórica cuando corresponde. Cualquier operación de push, despliegue o activación requiere autorización separada.

**ESTADO: backend implementado y desplegado en DARK. NOUS COMERCIAL OFF.** Este es un documento de preparación, no una autorización de activación. Un número WhatsApp UnderCodeEC. Tráfico elegible de Meta Ads y orgánico; no multi-tenant.

## 0. Candidato local A7-D12/A7-D13: `MONITOR_ONLY` y continuación durable

Esta sección describe código local posterior a R3. La tabla R6 y el historial inferior describen la versión servida en sus fechas; A7-D12 no está publicado, desplegado ni activado. `NOUS_PILOT_BUDGET_MODE=ENFORCE` conserva las cuotas previas. Solo el valor exacto `MONITOR_ONLY` deja de rechazar por `NOUS_PILOT_DAILY_REQUEST_LIMIT`, `NOUS_PILOT_DAILY_ESTIMATED_USD_LIMIT` y el umbral `NOUS_PILOT_QUEUE_ALERT_WAITING`; valores ausentes o inválidos usan `ENFORCE`. No usar `0`, `-1` ni cifras enormes como sustituto de esta política.

En `MONITOR_ONLY`, la reserva condicional en PostgreSQL sigue reclamando cada inbound una sola vez. Las reservas UTC siguen contándose; `NOUS_PILOT_ESTIMATED_USD_PER_REQUEST=0.116122`, `NOUS_PILOT_DAILY_REQUEST_ALERT=80`, `NOUS_PILOT_SPEND_ALERT_USD=4` y `NOUS_PILOT_QUEUE_ALERT_WAITING=5` son parámetros de lectura y alerta, no cuotas bloqueantes. Los eventos agregados `nous_pilot_dispatch`, `nous_pilot_threshold` y `nous_pilot_saturation` no contienen texto del cliente. La alerta diaria se emite al cruce y luego periódicamente; `billedUsd:null` sigue significando facturación desconocida. Si falla una lectura de métricas después de la reserva durable, se registra `nous_pilot_meter_unavailable` sin repetir el despacho.

La cola conserva concurrencia uno y una sola ventana de espera acotada, por defecto 120 segundos. El webhook ya confirma el inbound antes de que comience la respuesta automática; quien espera Nous es el worker `AutoReplyProcessor`, no la conexión HTTP del webhook. A7-D13 registra en `InboundTurn` la admisión de la cola y el resultado original. Si el trabajo sigue `waiting`, `delayed` o `active` reciente al vencer la ventana, la respuesta automática se desacopla sin reencolar inferencia. El worker Nous persiste un resultado exitoso en PostgreSQL antes de confirmar BullMQ; después se reanuda por la cola de respuestas automáticas y se vuelve a pasar por validación comercial y ledger Meta. Un resultado posterior a intervención humana queda suprimido por los controles de conversación y entrega existentes. Una ejecución activa demasiado antigua, un trabajo perdido o un resultado de proveedor incierto conserva bloqueo y revisión humana; no se reenvía a ciegas. La recuperación revisa turnos cada cinco segundos y considera abandonada una ejecución de respuesta automática tras 15 minutos; una caída de worker no promete respuesta mientras dure. BullMQ vuelve a eliminar resultados completados (`removeOnComplete:true`): la copia temporal en Redis ya no es el soporte de recuperación. Vigilar edad de pendientes, bloqueos, tareas humanas, parada operativa y entregas; 20 conversaciones sintéticas no implican capacidad ilimitada.

La migración local `20261026190000_nous_durable_continuation` añade cuatro columnas anulables e índice a `inbound_turns`; las filas anteriores conservan su comportamiento. `nousResult` contiene solo la respuesta estructurada original, con máximo 64 KB, y se limpia al cerrar o bloquear el turno. Mientras el turno siga pendiente puede permanecer en PostgreSQL; esto añade una copia de contenido y deja abierta la decisión de retención y privacidad. Para revertir código en un entorno futuro, primero detener nuevas admisiones, conciliar trabajos y entregas en vuelo, y volver a `ENFORCE`/operaciones OFF mediante un cambio controlado; no borrar las columnas ni resultados pendientes antes de conciliar. La reversión de esquema, si se aprobara, requiere una migración posterior y una ventana de mantenimiento. Esta migración solo se ejecutó en PostgreSQL de pruebas, no en producción.

`MONITOR_ONLY` no activa tráfico. La selección de nuevas conversaciones, `NOUS_PILOT_COMMERCIAL_ENABLED`, `NOUS_PILOT_OPERATIONS_ENABLED`, firma Meta, deduplicación, validación de salida, ledger de entregas, parada administrativa y límites por ejecución del agente A7-D8 continúan separados. F3/F4 siguen OFF. Para revertir esta política en una versión futura, restaurar `NOUS_PILOT_BUDGET_MODE=ENFORCE` y aplicar la configuración de forma controlada; para detener Nous, usar además el interruptor de operaciones y revisar trabajos en vuelo. Privacidad y retención permanecen pendientes de aprobación. Meta Ads se gestiona fuera de estas cuotas.

## 1. Evidencia de release y operación

- Backend A7-D10-R3: commit `370f5f97498ef2bad7bdc5ea69e01d19c667b76b`; imagen `sha256:4e9d85e29915c516d532d9ad4ea7e885b1c3102ed3cca630a692dadbcb3db297`; 313/313 tests en builder, PostgreSQL 25/25, HTTP/HTTPS 200 al informe R6.
- Nous Agent A7-D8 no cambió en R6 (imagen `sha256:403917d73eb19e9388ea5bf49a52da8b1282e092ec412637aa81ad930e4c7efe`). R5 validó su aislamiento con gateway real y mock de proveedor, no una campaña comercial.
- QA Nous normal R3 ya tuvo Meta `delivered/read` en dos partes; no se repite salvo razón concreta.

## 2. Selección de motor y origen

- Configuración DARK efectiva: `HERMES_CONVERSATION_ENGINE=gemini_direct`, `HERMES_PILOT_NEW_CONVERSATION_ENGINE` vacío, `NOUS_PILOT_COMMERCIAL_ENABLED=false`, `NOUS_PILOT_OPERATIONS_ENABLED=false`, `NOUS_HERMES_OPEN_INBOUND_TEST=false`, allowlist Nous vacía, F3/learning OFF.
- Para una futura semana Nous: verificación previa en el commit de flags efectivos, `META_PHONE_NUMBER_ID` aprobado; nuevo motor sólo para **conversaciones nuevas** elegibles del número. No activar con solo un flag y sin revisar el interruptor de operaciones. Las viejas conversaciones conservan selección previa.
- Origen inicial: `meta_ad` (ad/ctwa_clid), `organic` (post verificado), `unknown` en ausencia de prueba; atribuciones posteriores en mensaje, no modifican origen inicial. `sourceId` es ID de Meta, no nombre de campaña.
- Baja por texto: marketing `OPTED_OUT` si solicitud inequívoca; la atención de servicio puede continuar cuando procede. Handoff humano ante peticiones o errores. El ingreso del cliente no constituye autorización general de marketing.

## 3. Presupuestos y capacidad

| Ajuste R6 | Valor preparado | Carácter |
|---|---:|---|
| Límite Nous reservas/día | 100 | Configuración local operativa, no total mensajes conversación |
| Alerta peticiones | 80 | Control preparado; verificar nombre exacto de variable al operar |
| Cola alerta waiting | 5 | Concurrencia de Nous Agent=1; capacidad limitada |
| Estimación por reserva | USD 0.116122 | Cota presupuestaria conservadora; no factura |
| Tope diario IA estimada | USD 5 | Se aplica al intento siguiente antes de despacho |
| Alerta diario IA | USD 4 | Verificar emisión efectiva durante piloto |
| Cota A7-D8 agente por run | 1 POST Gemini, salida 4096 tokens y JSON entrada ≤16384 bytes | No limita cantidad de mensajes legítimos durante días |

**No imponer presupuesto fijo a Meta Ads:** el propietario cambia gastos desde **Ads Manager**; Hermes no interviene en pujas/anuncios. Los pagos Meta, WhatsApp y Google siguen sistemas distintos y el gasto combinado no tiene un hard cap en Hermes. Informe diario debe mostrar estimación ≠ uso reportado ≠ factura.

## 4. Manual mínimo de inicio futuro (no ejecutar sin autorización)

1. Verificar backend/agent exactos y manifests; healthy 7 servicios, PostgreSQL 25/25, Redis, colas/ledger, disco y memoria actuales. R6 cerró con **6 GB/89 %**; no construir nuevas imágenes mientras no haya margen adicional.
2. Verificar que la persona que atenderá handoff dispone de acceso, permisos `ADMIN/SALES_AGENT`, turno acordado y puede tomar la tarea; hay una incidencia histórica de revisión `failed` y una solicitud humana pendiente, no confundir con errores del piloto.
3. Validar `META_PHONE_NUMBER_ID`, Meta Business, ventana 24 h, aviso de privacidad, opt-out y tipos de consentimiento antes de enviar seguimientos.
4. Acordar/registrar política mínima de privacidad/retención; **NO APROBADA al corte** (la propuesta de analítica de 21 días es orientativa y el historial CRM requiere decisión aparte).
5. Verificar variables de cuotas reales y rango tolerado; costo facturado Google y Meta Ads siguen `UNKNOWN` hasta fuentes externas.
6. Solo si existe **permiso expreso nuevo**, habilitar motor para **nuevas conversaciones** y ambos controles Nous; F3/retrieval/review/shadow/summary OFF; verificar que el resto de conversaciones no se redirige. Definir responsable y señal de STOP.
7. Durante piloto: vigilar colas, edad/p95, errores, fallos de budget 500, derivación humana, Meta ledger/wamid y atribución. Medir cohortes diariamente con el SQL saneado. No lanzar campañas desde el CRM.
8. Para STOP: deshabilitar NUEVAS operaciones Nous, preservar trabajos en vuelo, analizar entregas ambiguas y asignar humano; no borrar colas ni reintentar un resultado incierto. Cambiar env requiere operación controlada de app, no conmutación inmediata sin reinicio.
9. Al terminar semana 1: no cambiar motor de conversaciones ya fijadas. Antes de semana 2, autorizar smoke Gemini Direct normal completo y fijar `gemini_direct` solo para nuevos inbounds/conversaciones conforme a diseño.

## 5. Informes y mejoras futuras

- Ejecutable SQL: `hermes-backend/scripts/undercode-pilot-report.sql`, ventana 30 días; respuesta agregada sin `ctwa_clid` crudo, teléfono, texto cliente ni secreto. No existe dashboard específico de atribución ni endpoint agregado nuevo en R3.
- Conversión comercial verificada: `LEAD_QUALIFIED`, `CONTRACT_WON` o `CONTRACT_LOST` solo con evento verificado/no invalidado. `billedUsd` continúa `null` sin factura.
- Deuda técnica: privacidad y retención no aprobadas, acceso al historial Nous, almacenamiento; facturación externa, métrica p95, Gemini Direct normal, F3/F4 y multitenancy no certificado. Ver registro de deuda.


---

<details>
<summary>Archivo histórico íntegro — corte fase A7-D10 local (expandir; NO representa el estado actual)</summary>

> ARCHIVO HISTÓRICO: a continuación se conserva el contenido fuente anterior sin cambiar su semántica original. Las autorizaciones y «próximos pasos» de aquel corte están superados por las actas posteriores.

# Piloto UnderCodeEC: preparación local A7-D10

Estado de esta entrega: **DARK**. No autoriza activar Nous, hacer push, desplegar ni probar inferencias reales. El único número admitido se toma de `META_PHONE_NUMBER_ID`; nunca se fija en código. Verificar ese valor en el entorno operativo antes de considerar la activación.

## Comportamiento

- `HERMES_PILOT_NEW_CONVERSATION_ENGINE=gemini_direct` fija Gemini a las conversaciones nuevas. Para una activación futura de Nous se requieren además `HERMES_PILOT_NEW_CONVERSATION_ENGINE=nous_hermes` y `NOUS_PILOT_COMMERCIAL_ENABLED=true`. La configuración entregada permanece en Gemini y con Nous comercial apagado.
- Un `phone_number_id` distinto del configurado, ausente o vacío se ignora antes de persistir trabajo. Si falta `META_PHONE_NUMBER_ID`, se rechaza el webhook incluso con Nous comercial apagado. El endpoint sigue exigiendo firma Meta válida.
- `pilotOrigin` se fija en `meta_ad` al recibir `referral.source_type=ad` o `ctwa_clid`, y en `organic` cuando no hay atribución de anuncio. Se guarda `pilotAd.sourceId` si existe. Una conversación existente conserva sus metadatos y motor; el payload crudo del mensaje conserva una referencia recibida después.
- La baja por botón se mantiene. Una solicitud textual inequívoca de dejar de recibir publicidad/promociones marca el consentimiento de marketing como `OPTED_OUT`; el flujo de atención de servicio continúa. Una baja de servicio no altera el consentimiento comercial.
- `NOUS_PILOT_OPERATIONS_ENABLED=false` detiene nuevas operaciones Nous antes de entrar a la cola y de nuevo antes de HTTP si el trabajo ya estaba en cola. El motor fijado no se cambia. El diagnóstico exige revisión humana. Para cambiar una variable de entorno se requiere actualizar la configuración del proceso; no hay panel de operación en esta fase.

## Umbrales y lectura

El transporte cuenta una petición cuando la reserva durable `providerDispatchReservedAt` queda registrada. La comprobación del límite y la reserva se serializan en una transacción PostgreSQL para que varios trabajadores no lo excedan. El límite diario UTC es `NOUS_PILOT_DAILY_REQUEST_LIMIT`. La cola advierte y frena una petición comercial cuando los trabajos pendientes alcanzan `NOUS_PILOT_QUEUE_ALERT_WAITING`. La estimación diaria es `peticiones × NOUS_PILOT_ESTIMATED_USD_PER_REQUEST`; el despacho comercial se bloquea si falta ese precio operativo o si la siguiente petición excede `NOUS_PILOT_DAILY_ESTIMATED_USD_LIMIT`. Se emiten eventos `nous_pilot_dispatch`, `nous_pilot_saturation` y `nous_pilot_threshold` con campos agregados, sin contenido del cliente. **`estimatedUsd` no representa facturación; `billedUsd` permanece desconocido.**

El reporte de los últimos 30 días está en [`scripts/undercode-pilot-report.sql`](../scripts/undercode-pilot-report.sql). Ejecutarlo sólo sobre una base autorizada y con el costo estimado configurado, por ejemplo `psql -v cost_per_request=0.02 -f scripts/undercode-pilot-report.sql`. La prueba reproducible con tablas temporales está en [`scripts/undercode-pilot-report.fixture.sql`](../scripts/undercode-pilot-report.fixture.sql). Agrupa conversaciones, solicitudes Nous y tokens conocidos por `meta_ad` y `organic`. Los valores nulos de uso o costo se mantienen desconocidos. Una atribución que llegue después del primer mensaje queda en la metadata de ese mensaje; no reclasifica el origen inicial de la conversación.

## Compatibilidad pendiente

La rama parte de A7-D4 (`8cf4725`). El código o contrato A7-D8 de Nous Agent no está disponible en las ramas locales; la integración sigue usando el alias privado `hermes-agent` y el contrato Chat Completions existente. Antes de activar el piloto se debe contrastar este contrato con A7-D8 y verificar el número, umbrales y ruta de revisión humana en un entorno autorizado.

</details>
