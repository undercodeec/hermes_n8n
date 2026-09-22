# Integración conversacional de Nous Hermes Agent

## Flujo y límites

`AutoReplyService` arma contexto del contacto y conversación actuales: historial reciente, resumen, ficha comercial, etapa, preguntas pendientes, tareas pendientes y completadas recientemente, capacidades y catálogo publicado. `NousHermesTransport` envía esos datos como datos no confiables en `messages` de Chat Completions al alias privado `hermes-agent`. No se pasan credenciales, teléfonos, herramientas ni sesiones del agente. El mensaje de sistema fija las reglas y el contenido del cliente permanece en rol de usuario.

El contenido final de la respuesta del agente es un objeto JSON con `replyText` obligatorio y campos opcionales `detectedIntent`, `suggestedTags`, `commercialProfilePatch`, `fieldEvidence`, `proposedNextAction` y `actionEvidence`. Se usa el contenido de Chat Completions que ya soporta el transporte; no se presupone soporte de `response_format` o JSON Schema del servidor. Si no hay JSON válido, el CRM crea un diagnóstico y usa el flujo de revisión existente. No se hace una segunda llamada al modelo.

El CRM valida tipos y longitudes. Una actualización de perfil exige un fragmento literal del mensaje actual para cada campo y que el valor propuesto coincida con esa evidencia; los turnos anteriores no autorizan sobrescribir una corrección reciente. Las etiquetas deben estar en `HERMES_ALLOWED_TAGS` y aparecer en el mensaje actual; si la lista está vacía no se acepta ninguna. Las intenciones usan `HERMES_ALLOWED_INTENTS` o el catálogo predeterminado. Las acciones admitidas son `none`, `request_handoff`, `request_callback` y `propose_quote_task`; requieren evidencia textual y una solicitud afirmativa del cliente. La cotización crea una tarea pendiente de valoración, no una cotización confirmada. El callback crea una tarea pendiente, no confirma una llamada. Handoff se registra mediante el servicio existente. Calendario, reservas, cobros, envíos, herramientas arbitrarias, MCP y acceso directo a PostgreSQL, Meta o n8n siguen deshabilitados.

Para Nous, la política comercial informa contexto pero no impone cuestionarios ni sustituye respuestas correctas. El CRM repara precios no autorizados y afirmaciones de citas confirmadas; retira frases con descuentos, plazos, pagos o inclusiones no respaldados y promesas de seguimiento sin acción, conservando las frases válidas. Se conservan las guardas de opt-out y handoff del webhook, ventana de WhatsApp, deduplicación, límite de cuota, cola global de inferencia y ledger durable de envíos. Gemini directo y `HermesService` permanecen disponibles para reversión.

En el primer fragmento del outbound, el ledger guarda motor, modelo reportado, traza, latencia, hash de la propuesta, rechazos y resultado de la acción. Guarda el texto propuesto solo si una corrección cambió la respuesta y no hubo diagnóstico de bloqueo; si no cambió, el mensaje saliente confirmado es también la propuesta. Los mensajes salientes del CRM contienen el texto efectivamente confirmado, incluso si se dividió en partes. Los logs generales solo registran códigos, identificadores internos, motor y latencia; no registran textos completos.

## Activar pruebas entrantes y revertir

Valores predeterminados seguros en el `backend.env` externo a Git:

```dotenv
HERMES_CONVERSATION_ENGINE=gemini_direct
NOUS_HERMES_CONVERSATION_ALLOWLIST=
NOUS_HERMES_OPEN_INBOUND_TEST=false
```

Para permitir conversaciones entrantes desde múltiples números, después de verificar la salud del agente y la cuota de Gemini Flash en la VPS:

```dotenv
HERMES_CONVERSATION_ENGINE=nous_hermes
NOUS_HERMES_OPEN_INBOUND_TEST=true
```

Solo el valor literal `true` habilita el modo abierto. Con `false`, la allowlist conserva su comportamiento por UUID; vacía nunca selecciona Nous. El único consumidor de `ConversationEngineService` es el procesador de respuestas entrantes. El cambio no programa campañas ni envíos proactivos. La configuración se aplica al reiniciar el servicio `app` de forma controlada.

Para revertir sin borrar datos:

```dotenv
HERMES_CONVERSATION_ENGINE=gemini_direct
NOUS_HERMES_OPEN_INBOUND_TEST=false
NOUS_HERMES_CONVERSATION_ALLOWLIST=
```

En la VPS, guardar una copia del `backend.env` anterior, editar estas tres variables, validar `docker compose --env-file /etc/hermes-crm/compose.env config --quiet` y recrear solo `app` según el runbook de despliegue. Drenar jobs activos y revisar filas `AMBIGUOUS` del ledger antes de concluir la reversión; no reintentarlas automáticamente. No se requiere migración para esta integración y no se modifican contactos, conversaciones ni entregas al desactivar el modo.

El alias `hermes-agent` y el proveedor Gemini Flash configurado detrás de Nous permanecen como estaban. La documentación de la instalación identifica `gemini-3.8-flash` como modelo efectivo; el CRM no envía un ID de proveedor distinto y no cambia su configuración.
