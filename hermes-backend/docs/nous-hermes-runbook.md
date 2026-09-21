# Runbook de Hermes CRM con Nous Hermes Agent

## Alcance y estado seguro

Este runbook corresponde al contrato privado VPS `contract_version=1`. La
implementación local no autoriza un canary ni conversaciones comerciales. Los
valores versionados de operación y rollback son:

```dotenv
HERMES_CONVERSATION_ENGINE=gemini_direct
NOUS_HERMES_CONVERSATION_ALLOWLIST=
```

Con estos valores todas las conversaciones usan `DirectGeminiEngine`; el CRM
no depende de Nous. Aunque se configure `nous_hermes`, una conversación que no
figure por su UUID interno en la allowlist continúa con Gemini directo. Un
identificador de motor desconocido falla cerrado.

## Contrato privado fijado

El único destino permitido por el cliente es:

```text
POST http://nous-hermes-api:8642/v1/chat/completions
model=hermes-agent
Authorization: Bearer <secreto montado>
```

HTTP es deliberado: el nombre sólo existe en la red Docker privada externa
`hermes_client_api`; el puerto `8642` no se publica en el host, Nginx o
Internet. El cliente rechaza cualquier URL distinta, redirecciones, credenciales
embebidas o parámetros de consulta. Envía contexto CRM stateless en `messages`
y nunca envía `X-Hermes-Session-Id`, `X-Hermes-Session-Key`, campos `provider`
ni herramientas.

Una respuesta se acepta sólo si el HTTP es satisfactorio, no hay `error` de
nivel superior, `finish_reason` existe y no es `error`, el contenido final es
texto válido, y no hay `tool_calls`, `reasoning_content` ni contenido
privilegiado. El modelo reportado sólo se conserva como `hermes-agent` cuando
coincide exactamente; de otro modo se registra `unknown`.

## Variables exactas

Mantener en el runtime del backend:

```dotenv
HERMES_CONVERSATION_ENGINE=gemini_direct
NOUS_HERMES_CONVERSATION_ALLOWLIST=
NOUS_HERMES_CHAT_COMPLETIONS_URL=http://nous-hermes-api:8642/v1/chat/completions
NOUS_HERMES_API_KEY_FILE=/run/secrets/nous_hermes_api_key
NOUS_HERMES_TIMEOUT_MS=45000
NOUS_HERMES_MAX_RESPONSE_BYTES=256000
NOUS_HERMES_CONTEXT_MAX_CHARS=12000
NOUS_HERMES_MAX_ATTEMPTS=3
NOUS_HERMES_BACKOFF_MS=1500
NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS=120000
```

No existen variables configurables para cambiar el alias, permitir HTTP
arbitrario, añadir headers de sesión o pasar el Bearer directamente. Los
campos obsoletos `NOUS_HERMES_API_KEY`, `NOUS_HERMES_MODEL`,
`NOUS_HERMES_IDENTITY_SECRET` y `NOUS_HERMES_ALLOW_INSECURE_HTTP` no deben
configurarse.

## Secreto y red Docker

La VPS prepara el Bearer fuera de Git en
`/etc/hermes-agent-client/api-key`, propietario `root:root` y modo `0600`.
Compose lo declara como secret y lo monta de sólo lectura en
`/run/secrets/nous_hermes_api_key`. No se debe copiar su contenido a `.env`,
Markdown, tickets, pruebas, imágenes, logs ni variables de frontend.

La imagen actual del backend no declara `USER`, por lo que su usuario efectivo
es root y puede leer el archivo montado sin ampliar permisos. Si posteriormente
se ejecuta como usuario no root, el cambio debe incluir un mecanismo de secret
compatible con ese UID; nunca resolverlo haciendo el archivo del host legible
para otros usuarios.

Antes de recrear el servicio:

```bash
sudo test -r /etc/hermes-agent-client/api-key
docker network inspect hermes_client_api >/dev/null 2>&1 || \
  docker network create hermes_client_api
docker compose config --no-interpolate
```

Sólo `app` se conecta a `hermes_client_api`; PostgreSQL, Redis y n8n permanecen
en la red predeterminada. No añadir `ports:` para `8642`.

## Despliegue preparado, no autorizado por este cambio

Con la allowlist todavía vacía:

```bash
docker compose build app
docker compose run --rm app npx prisma migrate deploy
docker compose up -d app
```

La migración debe completarse antes de reiniciar la aplicación porque crea el
ledger durable `automated_deliveries`. Si falla, no iniciar el nuevo contenedor.

Comprobar DNS y salud desde el mismo contenedor, sin imprimir Authorization:

```bash
docker exec hermes-app node -e "require('node:dns').lookup('nous-hermes-api',(e,a)=>{if(e)throw e;console.log(a)})"
docker exec hermes-app node -e "fetch('http://nous-hermes-api:8642/health').then(r=>{console.log(r.status);process.exit(r.ok?0:1)})"
docker exec hermes-app node -e "const fs=require('node:fs');const k=fs.readFileSync('/run/secrets/nous_hermes_api_key','utf8').trim();fetch('http://nous-hermes-api:8642/health/detailed',{headers:{Authorization:'Bearer '+k}}).then(r=>{console.log(r.status);process.exit(r.ok?0:1)})"
```

No imprimir la clave, headers, cuerpos completos de prompts/respuestas ni usar
`set -x`. Una prueba sintética autorizada debe usar una conversación ficticia y
una allowlist de un solo UUID. Vaciarla inmediatamente al terminar.

## Cola, límites y fallos de Nous

BullMQ usa la cola `nous-hermes-inference` y persiste
`globalConcurrency=1` en Redis, de modo que varias réplicas comparten el mismo
límite. Cada job se deduplica por el inbound (`nous-<inboundMessageId>`).

Sólo el HTTP `429` tipado del agente provoca reintentos: tres intentos como
máximo, backoff exponencial desde 1500 ms. Timeout, 401, 403, 5xx, respuesta
malformada, herramientas o `finish_reason=error` producen un resultado neutro
para el cliente y diagnóstico interno; no activan un segundo envío a Meta. Una
falla de Redis se reporta como `NOUS_HERMES_QUEUE_UNAVAILABLE`. No existe
fallback automático a otro proveedor durante el turno.

Eventos operativos útiles:

- `nous_hermes_request_failed`: código seguro y trace ID interno;
- `auto_reply_sent`: motor, modelo verificable y correlación;
- estados del ledger en PostgreSQL para la entrega a Meta.

Los detalles del proveedor y secretos nunca deben copiarse al texto del cliente.

## Ledger de entregas automáticas

Antes de llamar a Meta, cada parte se reserva en PostgreSQL con una clave única
`<sourceMessageId>:<deliveryKind>:<partIndex>`. Una transacción con advisory
lock vuelve a comprobar inbound más reciente, opt-out, handoff, estado de la
conversación y ventana de servicio de WhatsApp, y reclama atómicamente la fila.

Estados:

- `PREPARED`: reservada y elegible para una reclamación;
- `DISPATCHING`: un worker posee el lease y puede estar llamando a Meta;
- `CONFIRMED`: Meta devolvió `wamid` y el outbound quedó persistido;
- `REJECTED`: rechazo inequívoco anterior a aceptación, por ejemplo HTTP 4xx
  distinto de 429;
- `AMBIGUOUS`: Meta pudo aceptar (timeout, desconexión, 5xx, HTTP 200 sin
  `wamid`, excepción inesperada o lease vencido);
- `SUPPRESSED`: una guarda final impidió el envío.

`CONFIRMED`, `REJECTED`, `AMBIGUOUS` y `SUPPRESSED` son terminales. Una fila
`AMBIGUOUS` nunca se reenvía automáticamente, incluso tras reiniciar workers.
El único rechazo que vuelve a `PREPARED` es HTTP 429 explícito de Meta; el
reintento conserva la misma operación durable.

Consulta operativa, sin contenido del mensaje:

```sql
SELECT id, "operationKey", status, attempts,
       "dispatchStartedAt", "ambiguousAt", "reasonCode", "createdAt"
FROM automated_deliveries
WHERE status = 'AMBIGUOUS'
ORDER BY "createdAt" DESC;
```

### Conciliación y limitación real

El request de envío de WhatsApp no ofrece una clave de idempotencia del CRM y
el contrato disponible no aporta una API para consultar por `operationKey`.
Si el proceso cae después de que Meta acepte pero antes de persistir el `wamid`,
no es posible demostrar automáticamente si el cliente recibió el texto. El
operador debe correlacionar horario, contacto, webhooks/logs disponibles y la
consola de Meta sin asumir que una ausencia equivale a no enviado. Debe mantener
la fila `AMBIGUOUS`, abrir revisión humana y decidir fuera del reintento
automático. No editarla a `PREPARED` ni reencolarla.

## Fallos de n8n

La publicación de eventos de handoff hacia n8n es best-effort. Un fallo de n8n
se registra, pero no revierte el handoff ni bloquea la ruta normal de WhatsApp.
No utilizar el estado de n8n como confirmación de entrega a Meta.

## Rollback

1. Vaciar `NOUS_HERMES_CONVERSATION_ALLOWLIST`.
2. Establecer `HERMES_CONVERSATION_ENGINE=gemini_direct`.
3. Dejar de admitir nuevos jobs Nous, esperar los activos y revisar la cola
   `nous-hermes-inference`; no borrar jobs activos a ciegas.
4. Consultar todas las filas `AMBIGUOUS` y conservarlas para revisión; nunca
   reintentarlas automáticamente.
5. Reiniciar workers de forma controlada.
6. Verificar una conversación sintética autorizada con Gemini directo: un
   inbound, un lead y un único outbound.
7. No cambiar WABA, callback Meta, número, plantillas, PostgreSQL ni Redis y no
   eliminar el ledger.

Si es necesario retirar acceso a Nous después del drenaje, desconectar sólo
`hermes-app` de `hermes_client_api`; no destruir la red mientras el servicio VPS
la use.

## Evidencia requerida antes de cualquier canary

Ejecutar y conservar resultados exactos:

```text
npx prisma format
npx prisma validate
npx prisma generate
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run test:integration
npm run build
npm run lint
docker compose config --no-interpolate
```

La integración requiere `REDIS_INTEGRATION_URL` y
`DATABASE_INTEGRATION_URL` apuntando exclusivamente a servicios desechables.
Mocks no satisfacen esa puerta. Además se requiere una prueba conjunta
autorizada desde `hermes-app` contra la VPS; esta entrega local no la realiza y
no habilita conversaciones comerciales.
