# Runbook local de ConversationEngine y Nous Hermes

## Estado seguro

El valor predeterminado y de rollback es:

```dotenv
HERMES_CONVERSATION_ENGINE=gemini_direct
NOUS_HERMES_CONVERSATION_ALLOWLIST=
```

En este modo el CRM no necesita que Nous esté disponible. `DirectGeminiEngine` delega al `HermesService` existente y conserva sus prompts, contexto, políticas y formato.

## Requisitos antes de una conexión real

No configurar un contacto real hasta recibir `hermes-agent-vps-handoff.md` con `contract_version=1`, commit/tag fijado, ID Gemini efectivo, URI privada accesible desde el contenedor NestJS, Bearer entregado por canal seguro, contrato `/v1/chat/completions` probado, health/readiness, límites, tool allowlist y modo sin tráfico real. La URI `127.0.0.1` del host no sirve desde otro contenedor.

El handoff debe demostrar que el perfil del agente no puede usar shell, SQL, Meta, base de datos, calendario, cobros ni otras herramientas privilegiadas. Este adaptador no interpreta tool calls y los rechaza, pero eso no sustituye el aislamiento del servidor agente.

## Configuración de canary

Guardar secretos en el gestor de secretos del runtime, nunca en el frontend ni en Git:

```dotenv
HERMES_CONVERSATION_ENGINE=nous_hermes
NOUS_HERMES_CONVERSATION_ALLOWLIST=<conversation-uuid-1>,<conversation-uuid-2>
NOUS_HERMES_CHAT_COMPLETIONS_URL=https://<private-host>/v1/chat/completions
NOUS_HERMES_API_KEY=<secret-manager-reference>
NOUS_HERMES_MODEL=<exact-verified-gemini-model-id>
NOUS_HERMES_IDENTITY_SECRET=<independent-secret>
NOUS_HERMES_TIMEOUT_MS=45000
NOUS_HERMES_MAX_RESPONSE_BYTES=256000
NOUS_HERMES_CONTEXT_MAX_CHARS=12000
NOUS_HERMES_ALLOW_INSECURE_HTTP=false
```

Una conversación no incluida en la allowlist sigue usando Gemini directo aunque el flag indique `nous_hermes`. Un valor de motor desconocido falla cerrado. La selección no es aleatoria y se calcula con el ID interno de conversación.

El endpoint es stateless: el CRM envía historial canónico limitado y conocimiento aprobado. El header de identidad se deriva con HMAC; no incluye teléfono, correo o nombre. En el MVP toda respuesta válida produce `proposedActions=[{type:'none'}]`.

## Verificación local

```text
npm test -- --runInBand
npm run build
npm run test:e2e -- --runInBand
```

Los tests del motor cubren respuesta válida, config incompleta, cuerpo malformado/vacío, herramientas/reasoning, 401, 403, 429, 5xx, timeout, minimización de perfil y aislamiento de identidades. No hacen solicitudes reales.

Antes del canary conjunto, probar desde el mismo runtime/contenedor de NestJS: DNS/ruta, TLS, readiness, auth, límite de respuesta y modelo efectivo. No imprimir el Bearer ni el cuerpo completo de mensajes.

## Fallos

`NousHermesEngine` hace una sola solicitud. Un error se convierte en diagnóstico interno tipado y texto neutro; nunca se copia el body HTTP, stack o secreto al cliente. No existe fallback automático a otro proveedor. El CRM vuelve a comprobar estado/handoff e inbound más reciente antes del envío.

Los logs útiles son `nous_hermes_request_failed` y `auto_reply_sent`; este último incluye motor, modelo reportado y trace ID interno. Si el runtime no permite verificar el modelo, se registra `unknown`.

## Rollback

1. Vaciar `NOUS_HERMES_CONVERSATION_ALLOWLIST`.
2. Establecer `HERMES_CONVERSATION_ENGINE=gemini_direct`.
3. Reiniciar los workers de forma controlada y dejar de admitir nuevos jobs durante el drenaje si el despliegue lo requiere.
4. No reenviar jobs cuyo estado remoto sea ambiguo. Reconciliar primero outbound/`wamid` y revisar tareas de incidente.
5. Verificar una conversación de prueba: un inbound, un lead, un único outbound, handoff y respuesta manual.
6. Conservar logs y datos. No cambiar el callback Meta, WABA, número, plantillas ni borrar PostgreSQL.

La activación global queda prohibida hasta aprobar resultados reales y resolver la brecha durable del envío ambiguo descrita en `crm-baseline-agent.md`.
