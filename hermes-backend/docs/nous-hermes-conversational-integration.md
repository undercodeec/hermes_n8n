# Integración conversacional de Nous Hermes Agent

## Contrato de salida verificado en CRM (2026-09-22)

El punto de partida local fue `645709735ecbe491241d604f7413f485376525b0`.
El informe de la VPS confirma tres formas rechazadas, pero no conserva aquí el
JSON completo ni el **nombre exacto** del campo ajeno a `commercialProfilePatch`.
No se atribuye ese campo a una clave concreta: hay que comprobarlo en una nueva
prueba sintética de la VPS sin publicar datos de clientes. El prompt anterior
decía sólo «objeto opcional» y mostraba al agente un perfil con claves de CRM
como `recommendedPlan` y `pendingQuestions`; el validador sólo admitía 18 claves.
También enumeraba `none` y `request_callback` como palabras sin mostrar el
objeto `{ "type": ... }`, por lo que una cadena era una interpretación razonable
de la instrucción, aunque incompatible con el validador. La ausencia de
`actionEvidence` para una acción ejecutable era una brecha del validador de
entrada: la revisión determinista posterior la rechazaba. El parser sólo hace
`JSON.parse(message.content)`; recorta cadenas y proyecta los campos validados,
sin convertir una cadena en acción ni añadir evidencia.

| Clave del JSON | Tipo y obligación | Restricción y consumidor |
| --- | --- | --- |
| `replyText` | cadena obligatoria si no hay `replyParts` | No vacía, máximo `AI_MAX_OUTPUT_CHARS` (900 por defecto) para un mensaje. Si coexiste con `replyParts`, coincide con las partes unidas por un espacio. |
| `replyParts` | lista opcional que puede sustituir `replyText` | De 1 a 6 mensajes completos, no vacíos, cada uno de hasta `AI_MAX_OUTPUT_CHARS`; el CRM valida y entrega las partes en orden. |
| `detectedIntent` | cadena opcional | No vacía, máximo 80; `AutoReplyService` la contrasta con `HERMES_ALLOWED_INTENTS` o el catálogo predeterminado y descarta las no autorizadas. |
| `suggestedTags` | lista opcional de cadenas | Máximo 8, cada una `[a-z0-9_-]` de 1–40 caracteres; `reviewAgentProposal` exige allowlist `HERMES_ALLOWED_TAGS` y mención en el mensaje actual. |
| `commercialProfilePatch` | objeto opcional | Sólo las 18 claves indicadas abajo; valores de cadena no vacía de máximo 240. `contactPreference` sólo `WHATSAPP`, `CALL`, `VIDEO_CALL` o `EMAIL`. `reviewAgentProposal`, `AutoReplyService` y `LeadsService` consumen únicamente los valores respaldados. |
| `fieldEvidence` | objeto opcional | Una cadena literal no vacía, máximo 300, con la misma clave por cada campo propuesto; ninguna clave extra. La revisión exige que aparezca en el mensaje actual y respalde el valor. |
| `proposedNextAction` | objeto opcional | Formas exactas indicadas abajo; `NousHermesTransport` lo pasa a `reviewAgentProposal`. Sólo `AutoReplyService` solicita tareas o handoff tras revisión. |
| `actionEvidence` | cadena condicional | Obligatoria y no vacía, máximo 300, para una acción distinta de `none`; omitida cuando no hay acción. Debe ser fragmento literal del mensaje actual y acompañar una solicitud afirmativa. |

Claves permitidas de `commercialProfilePatch`: `service`, `company`, `sector`,
`location`, `need`, `businessNeeds`, `currentSituation`, `users`, `productCount`, `paymentNeeds`,
`shippingNeeds`, `inventoryNeeds`, `domainStatus`, `corporateEmailNeeds`,
`integrations`, `budget`, `timeline`, `lastObjection`, `contactPreference`.
La lista ejecutable está en `agent-output.contract.ts`; las claves de perfil
administradas por el CRM no son propuestas válidas.

Formas exactas de `proposedNextAction`:

```json
{"type":"none"}
{"type":"request_handoff","reason":"motivo no vacío (máximo 240 caracteres)"}
{"type":"request_callback"}
{"type":"propose_quote_task","summary":"resumen no vacío (máximo 500 caracteres)"}
```

No se admiten claves adicionales en el objeto de acción. Ausencia de acción y
`{"type":"none"}` equivalen a no ejecutar nada; en ambos casos se omite
`actionEvidence`. Una acción ejecutable sin evidencia se rechaza como respuesta
inválida antes de cualquier mutación. Con evidencia de forma válida, la revisión
determinista todavía puede rechazar la acción si el texto actual no respalda
una petición afirmativa. La cotización y la llamada crean tareas pendientes;
ninguna confirma un precio o una cita.

Ejemplo sin acción ni cambios de perfil:

```json
{"replyText":"Hola, ¿en qué puedo ayudarle?","detectedIntent":"info_general"}
```

Ejemplo con solicitud sintética «Quiero una cotización de un sitio web»:

```json
{"replyText":"Registraré su solicitud de cotización para revisión.","proposedNextAction":{"type":"propose_quote_task","summary":"Cotización de sitio web"},"actionEvidence":"Quiero una cotización de un sitio web"}
```

Chat Completions recibe este contrato como texto en el mensaje de sistema. El
request no usa `response_format`, JSON Schema, herramientas ni una segunda
llamada. Sigue pendiente verificar una respuesta real del agente configurado
en la VPS; las pruebas locales sintéticas no demuestran resolución en producción.

## Flujo y límites

`AutoReplyService` arma contexto del contacto y conversación actuales: historial reciente, resumen, ficha comercial, etapa, preguntas pendientes, tareas pendientes y completadas recientemente, capacidades y catálogo publicado. `NousHermesTransport` envía esos datos como datos no confiables en `messages` de Chat Completions al alias privado `hermes-agent`. No se pasan credenciales, teléfonos, herramientas ni sesiones del agente. El mensaje de sistema fija las reglas y el contenido del cliente permanece en rol de usuario.

El contenido final de la respuesta del agente es un objeto JSON con `replyText` o `replyParts` y campos opcionales `detectedIntent`, `suggestedTags`, `commercialProfilePatch`, `fieldEvidence`, `proposedNextAction` y `actionEvidence`. Se usa el contenido de Chat Completions que ya soporta el transporte; no se presupone soporte de `response_format` o JSON Schema del servidor. Si no hay JSON válido, el CRM crea un diagnóstico y usa el flujo de revisión existente. No se hace una segunda llamada al modelo.

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
