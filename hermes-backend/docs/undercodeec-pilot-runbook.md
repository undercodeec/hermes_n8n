# Piloto UnderCodeEC: preparación local A7-D10

Estado de esta entrega: **DARK**. No autoriza activar Nous, hacer push, desplegar ni probar inferencias reales. El único número admitido se toma de `META_PHONE_NUMBER_ID`; nunca se fija en código. Verificar ese valor en el entorno operativo antes de considerar la activación.

## Comportamiento

- `HERMES_PILOT_NEW_CONVERSATION_ENGINE=gemini_direct` fija Gemini a las conversaciones nuevas. Para una activación futura de Nous se requieren además `HERMES_PILOT_NEW_CONVERSATION_ENGINE=nous_hermes` y `NOUS_PILOT_COMMERCIAL_ENABLED=true`. La configuración entregada permanece en Gemini y con Nous comercial apagado.
- Un `phone_number_id` distinto del configurado se ignora antes de persistir trabajo. Si se intentara habilitar Nous comercial sin número configurado, se rechaza el webhook. El endpoint sigue exigiendo firma Meta válida.
- `pilotOrigin` se fija en `meta_ad` al recibir `referral.source_type=ad` o `ctwa_clid`, y en `organic` cuando no hay atribución de anuncio. Se guarda `pilotAd.sourceId` si existe. Una conversación existente conserva sus metadatos y motor; el payload crudo del mensaje conserva una referencia recibida después.
- La baja por botón se mantiene. Una solicitud textual inequívoca de dejar de recibir publicidad/promociones marca el consentimiento de marketing como `OPTED_OUT`; el flujo de atención de servicio continúa. Una baja de servicio no altera el consentimiento comercial.
- `NOUS_PILOT_OPERATIONS_ENABLED=false` detiene nuevas operaciones Nous antes de entrar a la cola y de nuevo antes de HTTP si el trabajo ya estaba en cola. El motor fijado no se cambia. El diagnóstico exige revisión humana. Para cambiar una variable de entorno se requiere actualizar la configuración del proceso; no hay panel de operación en esta fase.

## Umbrales y lectura

El transporte cuenta una petición cuando la reserva durable `providerDispatchReservedAt` queda registrada. El límite diario UTC es `NOUS_PILOT_DAILY_REQUEST_LIMIT`. La cola advierte y frena una petición comercial cuando los trabajos pendientes alcanzan `NOUS_PILOT_QUEUE_ALERT_WAITING`. La estimación diaria es `peticiones × NOUS_PILOT_ESTIMATED_USD_PER_REQUEST`; el despacho comercial se bloquea si falta ese precio operativo o si la siguiente petición excede `NOUS_PILOT_DAILY_ESTIMATED_USD_LIMIT`. Se emiten eventos `nous_pilot_dispatch`, `nous_pilot_saturation` y `nous_pilot_threshold` con campos agregados, sin contenido del cliente. **`estimatedUsd` no representa facturación; `billedUsd` permanece desconocido.**

El reporte de los últimos 30 días está en [`scripts/undercode-pilot-report.sql`](../scripts/undercode-pilot-report.sql). Ejecutarlo sólo sobre una base autorizada y con el costo estimado configurado, por ejemplo `psql -v cost_per_request=0.02 -f scripts/undercode-pilot-report.sql`. Agrupa conversaciones, solicitudes Nous y tokens conocidos por `meta_ad` y `organic`. Los valores nulos de uso o costo se mantienen desconocidos. Una atribución que llegue después del primer mensaje queda en la metadata de ese mensaje; no reclasifica el origen inicial de la conversación.

## Compatibilidad pendiente

La rama parte de A7-D4 (`8cf4725`). El código o contrato A7-D8 de Nous Agent no está disponible en las ramas locales; la integración sigue usando el alias privado `hermes-agent` y el contrato Chat Completions existente. Antes de activar el piloto se debe contrastar este contrato con A7-D8 y verificar el número, umbrales y ruta de revisión humana en un entorno autorizado.
