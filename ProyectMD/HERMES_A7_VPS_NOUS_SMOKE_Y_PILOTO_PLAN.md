# A7 — procedimiento futuro en Codex VPS: smoke Nous y piloto

**Documento operativo; no ejecutado.** Requiere autorización separada para cada cambio VPS, llamada real QA, apertura de piloto y anuncios. Alcance: una instancia, un negocio y un número WhatsApp. El punto de partida declarado es A6 en DARK, imagen `sha256:93684d3ff2612d7b8ab635bcb9ef39dd35e50f511a3d2459f146cc986ddf1bc2`, OCI `a4a70fb7ccaa4f6e0b456161b7e373f777b2a0e2`, 25 migraciones y F3 OFF; Codex VPS debe comprobarlo. El parche A7 no añade migraciones.

## 1. Gate de lectura y preparación

1. Reconciliar el acta A6-D3-S1 y el Round A completo con la configuración, imagen, logs, `InboundTurn` y ledger efectivos. Confirmar `MAX_TOKENS` suprimido y cero despachos Meta duplicados; no extrapolar del prompt.
2. Verificar commit/tree de la rama A7 que se publique por un gate Git aparte, estado limpio, imagen actual, 25 migraciones, colas, DNS/TCP de `nous-hermes-api`, WABA/número, plantilla aprobada, consentimiento y operador humano. No imprimir secretos ni transcripciones en la terminal.
3. Comprobar backup reciente y restauración/rollback viable antes de cambiar `hermes-app`. Mantener `postgres`, `redis`, `n8n`, bridge y auxiliares intactos. Si hay varios negocios o números independientes, detener ampliación como `BLOCKED_MULTI_TENANT`.
4. Inspeccionar en runtime del agente Nous proveedor/modelo/versión, cuota, cap de tokens, pensamiento, timeout, reintentos y ruta de salida. Registrar evidencia saneada. El alias HTTP `hermes-agent` no demuestra el modelo fundacional; si no se puede observar, etiquetar `underlying_model=UNKNOWN`.

## 2. DARK app-only y controles

Con autorización de despliegue distinta, construir/revisar una imagen A7 con commit/OCI trazables, reemplazar **solo** `hermes-app`, sin ejecutar migraciones (salvo descubrimiento documentado y autorización nueva). Mantener `HERMES_CONVERSATION_ENGINE=gemini_direct`, `NOUS_HERMES_OPEN_INBOUND_TEST=false`, allowlist Nous vacía, `HERMES_PILOT_NEW_CONVERSATION_ENGINE` vacío inicialmente, `F3_CANARY_RUN_GUARD_ENABLED=false`, caps F3 OFF y los cuatro `LEARNING_*` OFF. Verificar webhook firmado, CRM, jobs y ledger sin activar IA para tráfico real.

La llave inmediata de IA es `hermes:ai:disabled` en Redis: valor literal `1` bloquea nuevos consumos de cuota; ausencia de llave permite el flujo normal. Probar lectura y cambio en una ventana autorizada con control de acceso y auditoría del operador. **La llave no cancela trabajos ya iniciados ni borra lotes**: inspeccionar in-flight, `DISPATCHING`/`AMBIGUOUS`, derivar a humano y evitar reenvíos manuales del mismo source. No apagar el CRM. No cambiar `AI_GUARD_FAIL_CLOSED=true` a false.

Antes de cualquier piloto fijar valores versionados y coste tolerable para `HERMES_MODEL`, `HERMES_MAX_OUTPUT_TOKENS`, `HERMES_REASONING_EFFORT` (inicial `low` si el endpoint lo acepta), `HERMES_COMPLETION_ATTEMPTS`, cuotas por contacto/global y límites Nous. La cifra de 1.500 de F3 QA no es cap comercial. Si el proveedor remoto no ofrece tope monetario fiable, usar un cupo de contactos/turnos muy pequeño, revisión diaria de consumo y límite administrativo de proveedor; registrar que el costo facturado sigue `UNKNOWN` hasta conciliación.

## 3. Smoke Nous del propietario

Con permiso explícito para un mensaje real QA, configurar `HERMES_PILOT_NEW_CONVERSATION_ENGINE=nous_hermes` y dejar los flags F3/F4 y `OPEN_INBOUND_TEST` apagados. Usar un contacto de prueba nuevo con opt-in y un inbound fresco. Comprobar secuencia: firma/dedupe → conversación con `metadata.pilotEngine=nous_hermes` → `InboundTurn` → puente Nous → `finish_reason=stop`, contenido autorizado → batch único por `sourceMessageId` → `AutomatedDelivery.CONFIRMED` y `wamid` Meta persistido. Un HTTP 200 o `PREPARED` no certifica entrega. Simular redelivery del mismo webhook y verificar ningún WhatsApp adicional. Probar handoff y apagado de IA con operador disponible. Si falta evidencia, volver a DARK con IA deshabilitada y resolver causa concreta; **no abrir campaña**.

## 4. Piloto limitado: siete días completos por fase

La semana 1 empieza al abrir tráfico opt-in real autorizado, no al redactar este documento. `HERMES_PILOT_NEW_CONVERSATION_ENGINE=nous_hermes` fija solo conversaciones creadas en esa fase. Mantener campaña, objetivo, oferta y creatividades lo más constantes posible; subir tráfico gradualmente solo con personal de guardia. Revisar diariamente volumen, conversiones, satisfacción, sin respuesta, handoff, errores, `MAX_TOKENS`, `AMBIGUOUS`, entrega confirmada, p50/p95 inbound→Meta, input/output/thinking, presupuesto y consumo facturado si existe.

**Antes de semana 2:** hacer un smoke Gemini Direct distinto, autorizado, con una conversación nueva y un source nuevo. Confirmar `finishReason=STOP`, respuesta completa y segura, un batch y Meta `CONFIRMED`. El Round A F3 con `MAX_TOKENS` **no** satisface este gate. Solo entonces cambiar `HERMES_PILOT_NEW_CONVERSATION_ENGINE=gemini_direct` para conversaciones nuevas y contar siete días completos desde la apertura efectiva de esa fase. Las conversaciones A7 ya creadas retienen Nous en `Conversation.metadata`; no cambiar su motor ni reprocesar lotes. Las conversaciones antiguas sin pin quedan fuera del benchmark y deben seguir con el default heredado controlado.

## 5. Datos, evaluación y parada

Conservar los registros operacionales existentes bajo permisos ADMIN restringidos. Para una exportación offline consentida: seleccionar solo conversaciones opt-in de este único negocio, excluir secretos/pagos/datos de terceros, sustituir IDs y teléfonos por seudónimos HMAC con clave separada del export, eliminar `rawPayload` y prompts, revisar manualmente la redacción y entregar un conjunto cifrado con acceso nominal y plazo de borrado. No enviar transcripciones reales al segundo proveedor. El conjunto mínimo por turno debe tener pseudónimo de conversación/source, motor y configuración, alias y modelo subyacente verificado o `UNKNOWN`, referral/campaña cuando exista, tiempos, intentos/HTTP/finishReason, tokens y latencia, costo **estimado** o `UNKNOWN`, costo **facturado** solo conciliado, estado ledger/Meta, handoff, feedback y error. Si no puede extraerse sin PII o faltan campos críticos, bloquear la comparación cuantitativa y resolver observabilidad antes de escalar.

La comparación de dos semanas es **observacional**. Segmentar por fecha de primera entrada, anotar diferencias de volumen, calidad y estacionalidad. Para comparar calidad directamente, evaluar offline una muestra anonimizada y consentida por humanos. No activar reviewer F3 ni summary F4 por el mero almacenamiento.

**Parada inmediata:** smoke Nous o Gemini sin respuesta y Meta confirmados; `MAX_TOKENS`/texto truncado despachado; duplicado o ledger ambiguo no resuelto; falta de handoff/operador; gasto o tasa de errores fuera del cupo; consentimiento, ventana o plantilla inválidos; dato sensible cruzado entre negocios. Activar llave IA, registrar fuentes afectadas y estado de cada ledger, atender con humano y mantener CRM. No borrar reservas ni intentar fallback de otro motor para el mismo `sourceMessageId`.

`PROD_CHANGED=NO` · `PUSH=NO` · `DEPLOY=NO` · `META_ADS=NO` · `REAL_PROVIDER_CALLS=0` · `STOP=YES`.
