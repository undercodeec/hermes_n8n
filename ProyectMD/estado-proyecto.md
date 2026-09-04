# Estado real y documento maestro — Proyecto Hermes CRM

> **Única fuente de verdad documental de esta carpeta.**
>
> **Fecha de corte:** 2026-09-03, zona horaria `America/Guayaquil`.
>
> Este documento reemplaza los planes, guías, contratos, bitácoras y resúmenes Markdown anteriores de `ProyectMD/`. Cuando el código, Git y un documento histórico se contradicen, prevalecen el código y las verificaciones reproducibles. Las afirmaciones sobre el VPS no comprobadas en esta auditoría se identifican como evidencia histórica, no como estado confirmado hoy.

## Actualización productiva — 2026-09-03 (America/Guayaquil)

Esta actualización prevalece sobre las secciones anteriores que clasificaban como pendiente el despliegue del CRM, proxy u OTP. Distingue evidencia de VPS del código publicado posteriormente.

### Estado confirmado de producción

| Área | Implementado | Probado | Desplegado | Certificado E2E |
|---|---|---|---|---|
| Hermes Backend | Sí | Arranque y documentación HTTP | Sí, commit observado `09d38bc` | No integral |
| Contenedor `hermes-app` | Sí | Arranque y `/api/docs` HTTP 200 | Sí, puerto 3003 | Sólo HTTP |
| Proxy Undercodeec → Hermes | Sí | `/api/hermes/docs/` HTTP 200 | Sí | Sólo HTTP |
| Solicitud OTP de Admin | Sí | Respuesta HTTP 200 reportada | Sí | Solicitud validada; canje completo no certificado aquí |
| Campañas WhatsApp | Sí, commits `44feef4`, `09d38bc` y `26891a3` | Pruebas locales focalizadas y build | `26891a3` publicado en `origin/main`; despliegue VPS, activación y envío no confirmados | No |

El despliegue observado usa `/var/www/hermes/hermes-backend`, rama `main`, servicio Compose `app` y contenedor `hermes-app`. La aplicación quedó operativa en el puerto 3003. PostgreSQL, Redis y n8n no fueron reconstruidos intencionalmente durante la recreación controlada de `app`.

### Configuración CRM compartida

- Hermes y Undercodeec tienen `CRM_HERMES_PROOF_SECRET=<CONFIGURADO>` y el valor debe ser idéntico en ambos entornos.
- `CRM_OTP_HASH_SECRET=<CONFIGURADO>` es independiente y permanece únicamente en Undercodeec/Admin.
- `CRM_OPERATOR_EMAIL=<CONFIGURADO>` está configurado en ambos servicios; el identificador no se expone en esta documentación ni en la UI pública de login.
- La evidencia reporta permisos restrictivos y respaldo previo de los archivos de entorno. No se registran secretos, tokens, contraseñas ni OTPs en este documento.

### Correcciones históricas resueltas

- El proxy de Next.js requiere base `https://hermes.undercodeec.com/api`; sin el sufijo `/api` respondía 404 para rutas reenviadas.
- La ausencia inicial de secretos CRM en Undercodeec provocó un HTTP 500 al solicitar OTP. Tras configurar valores enmascarados y reiniciar la API, `request-code` respondió HTTP 200 con mensaje genérico.
- Los errores de PM2, assets Next.js, `paymentSessions` y variables faltantes deben tratarse como históricos si no existe una línea nueva con timestamp, uptime y proceso actual que los reproduzca.

### Pendientes reales

1. Certificar E2E el ciclo OTP completo: solicitud, verificación, canje de prueba Hermes, sesión CRM y rechazo de reuso.
2. Ejecutar la aceptación funcional de WhatsApp, handoff, respuesta humana, n8n/Telegram y recuperación de BullMQ con evidencia enmascarada.
3. Resolver la política de persistencia/alta disponibilidad de OTP y `jti`, y decidir el tratamiento del login por contraseña de emergencia.
4. Desplegar y verificar `26891a3` para que las respuestas de campaña queden exclusivamente en atención humana; después ejecutar la prueba controlada de campañas.

## 1. Resumen ejecutivo

Hermes es un CRM conversacional ligero para un único operador. Recibe conversaciones de WhatsApp Cloud API, usa Gemini mediante una interfaz compatible con OpenAI, guarda el estado comercial en PostgreSQL, deriva casos a una persona y utiliza n8n/Telegram para notificaciones auxiliares.

El proyecto se encuentra en la fase de **cierre técnico del MVP y preparación de puesta en producción del CRM**: el backend, la interfaz web y el flujo de autenticación OTP están implementados y versionados; quedan por completar los controles de seguridad, el despliegue aislado y la validación integral con servicios reales.

Estado real a la fecha de corte:

- El **backend CRM está implementado, publicado en `main` y pasa sus verificaciones locales actuales**.
- El **frontend CRM está implementado y fusionado en `origin/main`** del repositorio web. Sus archivos CRM locales coinciden con esa referencia remota local.
- El flujo **WhatsApp → Meta → NestJS → Gemini → WhatsApp** fue reportado como validado con una conversación real el 2026-07-21. Esa producción no se volvió a consultar durante esta auditoría.
- Los workflows `lead.qualified` y `conversation.handoff_requested` fueron reportados como activos y probados con HMAC → n8n → Telegram en julio. No se comprobó hoy el panel de n8n ni Telegram.
- **No existe evidencia de que la nueva UI CRM, el proxy, la migración CRM y el acceso OTP hayan sido desplegados y probados de extremo a extremo en producción.** El último estado, 2026-07-31, los deja pendientes.
- Descripción correcta: **implementación local/publicada completa para el MVP; despliegue CRM y validación productiva final pendientes**.
- Hay dos brechas de autenticación: el anti-reuso de la prueba OTP en Hermes vive en memoria y el login público por contraseña continúa habilitado.
- `docker-compose.yml` publica PostgreSQL y Redis en todas las interfaces y contiene credenciales de ejemplo débiles. No debe usarse tal cual en un entorno expuesto.

## 2. Criterio de evidencia

| Etiqueta | Significado |
|---|---|
| **Confirmado** | Existe en código/Git local y fue inspeccionado o ejecutado el 2026-08-03. |
| **Reportado** | Consta en bitácoras; requiere VPS, Meta, n8n o Telegram para reconfirmarse. |
| **Pendiente** | No está implementado, desplegado o suficientemente probado. |
| **Fuera del MVP** | Se dejó deliberadamente para una etapa posterior. |

No convertir una afirmación “reportada” en “confirmada” sin fecha, comando/acción, resultado, commit y evidencia enmascarada.

## 3. Objetivo y alcance

Publicar un espacio operativo en `https://undercodeec.com/admin/crm` donde el operador pueda:

- iniciar sesión con un código de un solo uso enviado al correo autorizado;
- ver todos los contactos como leads `NEW`;
- consultar resumen, pipeline, ficha de lead y conversaciones;
- identificar cuándo Hermes promovió un lead por intención comercial;
- tomar un handoff y bloquear respuestas automáticas;
- responder manualmente por WhatsApp Cloud API dentro de la ventana permitida;
- resolver, cerrar o devolver una conversación a Hermes;
- abrir desde Telegram el registro que requiere atención.

### Incluido en el MVP

- Un operador principal; roles técnicos `ADMIN` y `SALES_AGENT`.
- Resumen y funnel.
- Pipeline `NEW`, `CONTACTED`, `QUALIFIED`, `PROPOSAL`, `NEGOTIATION`, `WON`, `LOST`.
- Búsqueda, filtros, paginación y detalle de leads.
- Inbox, historial, prioridad de handoffs y respuesta humana.
- Auditoría de cambios manuales, handoffs y mensajes humanos.
- Notificaciones de lead calificado y solicitud humana mediante n8n/Telegram.

### Fuera del MVP o no implementado

- Equipos múltiples, distribución automática y permisos finos.
- Etiquetas relacionales (`Tag`, `ContactTag`, `LeadTag`). Hoy sólo existe `commercialTags` en el estado conversacional.
- Envío desde CRM de plantillas aprobadas fuera de 24 horas. Se bloquea texto libre, pero no existe selección/envío completo de plantilla.
- WebSocket/tiempo real, secuencias masivas y WhatsApp Web/App no oficial.
- Flujos completos `conversation.stalled`, `task.followup_due`, `quote.requested` y `payment.intent_detected`.
- Dashboard de BullMQ, alertas de cola fallida y outbox transaccional.

## 4. Arquitectura vigente

```text
Cliente WhatsApp
  -> Meta WhatsApp Cloud API
  -> Nginx/TLS
  -> Backend Hermes (NestJS :3003)
       |-> PostgreSQL: fuente de verdad
       |-> Gemini/OpenAI-compatible: respuesta e intención
       |-> Meta Graph API: salida
       `-> EventEmitter -> BullMQ/Redis -> n8n (HMAC) -> Telegram

Operador
  -> Next.js /admin/crm
  -> /api/hermes/* -> Nginx -> Hermes /api/*
```

| Componente | Responsabilidad | No debe ser |
|---|---|---|
| PostgreSQL | Estado oficial del CRM, conversaciones y auditoría. | Sustituido por UI, n8n o memoria de IA. |
| Backend Hermes | Reglas, persistencia, auth, Meta, IA, handoff y APIs. | Un proxy de n8n. |
| Gemini vía `HermesService` | Respuesta estructurada e intención. | Fuente oficial del funnel. |
| n8n | Automatizaciones externas y notificaciones. | Camino crítico o fuente de verdad. |
| Next.js | Interfaz del operador. | Cliente directo de DB, Meta o secretos. |

## 5. Repositorios, ramas y commits

Son dos repositorios independientes; no convertir Hermes en submódulo del repositorio web.

### Backend Hermes

```text
Repositorio: https://github.com/undercodeec/hermes_n8n.git
Aplicación:  .../Hermes/hermes-backend/
Rama local:  main
HEAD:        5ff5c5e docs: consolidate Hermes project status
origin/main: 5ff5c5e (referencia local inspeccionada)
Funcional:   4a5362e feat(auth): exchange admin OTP proof for CRM session
Anterior:    1406545 feat(crm): consolidate leads, handoffs and operator workflows
```

`hermes-backend/` no tiene cambios propios. El repositorio padre sí contiene cambios ajenos/preexistentes (`.claude`, documentos movidos, `.tokensave`, `capturas`); no mezclarlos con deployment o commits CRM.

### Web/Admin

```text
Repositorio: https://github.com/undercodeec/websiteUndercodeec.git
Aplicación:  .../undercodeec_nextjs/
Rama local:  feat/asistente-ia-dos-modos
HEAD local:  ae280ed feat(crm): add Hermes operator workspace
Upstream:    eliminado
origin/main: 139ca8a Merge pull request #1 from undercodeec/feat/asistente-ia-dos-modos
```

Commits relevantes incluidos en `origin/main`:

```text
139ca8a Merge pull request #1 from undercodeec/feat/asistente-ia-dos-modos
ae280ed feat(crm): add Hermes operator workspace
40b74a9 fix(crm): proxy Hermes API through Nginx
e48a0ef docs(crm): record passwordless auth status
9e1e6e9 feat(admin): add Hermes CRM passwordless OTP proof
```

Los hashes de archivos CRM, OTP, Nginx y env coinciden con `origin/main`. El árbol web completo está muy sucio con cambios ajenos. **No desplegar ese árbol ni fusionarlo en bloque.** Usar una copia limpia de `main` y `git pull --ff-only`.

### Versionado de este documento

El `.gitignore` de Hermes contiene `*.md`; este archivo permanece ignorado hasta incorporarlo explícitamente. Para protegerlo con Git se necesita añadir desde la raíz:

```gitignore
*.md
!ProyectMD/estado-proyecto.md
```

## 6. Backend confirmado

### Stack y módulos

- NestJS 11, TypeScript 5.7, Prisma 5.22, PostgreSQL 16.
- JWT/Passport, bcrypt, Swagger en `/api/docs`.
- EventEmitter2, BullMQ, Redis/ioredis y `nestjs-cls` para `traceId`.
- Axios para Gemini, Meta y n8n.
- Módulos: Auth, Webhook, Meta, Hermes, Contacts, Leads, Conversations, Messages, Products, PriceLists, Knowledge, Playbooks, Handoff, Tasks, Campaigns, Analytics, N8n, Prisma y Trace.

### Persistencia

Modelos principales:

- `User`, `Contact` (`waId` único), `Lead`, `Conversation`, `ConversationState`;
- `Message`, con remitente y `sentByUserId` para mensajes humanos;
- `Product`, `PriceList`, `KnowledgeDocument`, `SalesPlaybook`;
- `Task`, `HumanHandoff`, `CampaignSource`, `AdsMetadata`, `AuditLog`.

Migraciones presentes:

```text
20260628184421_init
20260728150000_crm_consolidation
```

No existe `CrmAuthProof`; el `jti` consumido no se persiste en PostgreSQL.

### Flujo entrante

1. Meta llama `POST /webhooks/meta/whatsapp`.
2. Se verifica `X-Hub-Signature-256`.
3. Se crea/actualiza contacto por `waId` y se obtiene la conversación.
4. Se guarda `INBOUND` y se crea/recupera el lead `NEW`.
5. Si está `HANDED_OFF`, se guarda el mensaje sin respuesta automática.
6. Se construye contexto y se llama a Gemini mediante `HermesService`.
7. Se evalúan intenciones/keywords de handoff y calificación.
8. Se crea handoff o se promueve el mismo lead a `QUALIFIED` cuando aplica.
9. Se responde por Meta, se guarda `OUTBOUND` y se actualiza el estado.
10. Eventos importantes se encolan a n8n fuera del núcleo transaccional.

### Reglas confirmadas

- Se reutiliza un lead abierto por contacto; no se crea uno por mensaje.
- Tras `WON`/`LOST`, otra oportunidad requiere acción explícita.
- La calificación automática depende de `detectedIntent`, no de score de cierre de Gemini.
- `LEAD_QUALIFICATION_INTENTS`, `HANDOFF_INTENTS` y `HANDOFF_KEYWORDS` son configurables.
- Un handoff abierto bloquea a Hermes.
- Al resolver se elige `RETURN_TO_HERMES`, `CLOSE_CONVERSATION` o `KEEP_HUMAN`.
- Mensaje humano: `OUTBOUND`, `sender=HUMAN`, usuario responsable.
- Fuera de 24 horas, texto libre devuelve `WHATSAPP_TEMPLATE_REQUIRED`.
- Cambios manuales relevantes generan auditoría.

## 7. API CRM confirmada

Requiere `Authorization: Bearer <JWT Hermes>`, salvo webhook Meta y endpoints públicos indicados.

### Autenticación

```text
POST /api/auth/login       Público; correo + contraseña; sigue habilitado.
POST /api/auth/crm-proof   Público; canjea la prueba OTP de Admin.
GET  /api/auth/profile     JWT.
POST /api/auth/register    JWT ADMIN.
```

### Leads

```text
GET /api/leads              GET /api/leads/funnel
GET /api/leads/:id          POST /api/leads
PUT /api/leads/:id          DELETE /api/leads/:id (ADMIN)
```

Incluye paginación, búsqueda y filtros por etapa, intención, fechas, handoff y respuesta de Hermes.

### Conversaciones

```text
GET  /api/conversations
GET  /api/conversations/:id
GET  /api/conversations/:id/messages
POST /api/conversations/:id/reply
PUT  /api/conversations/:id/close
```

Incluyen `replyWindow`: apertura, último inbound, cierre y necesidad de plantilla.

### Handoffs

```text
POST /api/handoff          GET /api/handoff
GET  /api/handoff/:id      PUT /api/handoff/:id/take
PUT  /api/handoff/:id/assign
PUT  /api/handoff/:id/resolve
```

La creación es idempotente mientras haya un handoff abierto.

### Analítica

```text
GET /api/analytics/crm-overview
GET /api/analytics/funnel
GET /api/analytics/conversations
GET /api/analytics/response-times
GET /api/analytics/costs
GET /api/analytics/campaigns
```

### Endpoint temporal

`POST /internal/test-event`, protegido con `X-Internal-Token`, aún permanece pese al TODO de retirarlo tras validar n8n. Falla cerrado si el secreto falta/es débil, pero debe eliminarse o formalizarse.

## 8. Autenticación OTP: realidad y brechas

Flujo implementado:

1. Navegador → Admin `POST /api/crm/auth/request-code`.
2. Admin autoriza el correo configurado, genera OTP de 8 dígitos y envía correo.
3. Admin conserva HMAC, limita solicitudes/intentos y consume el código al verificar.
4. `POST /api/crm/auth/verify-code` emite prueba breve: `iss=undercodeec-admin`, `aud=hermes-crm`, `ADMIN`, `jti` y expiración corta.
5. Frontend → Hermes `POST /api/auth/crm-proof`.
6. Hermes valida HS256, claims, operador, tiempo y `jti`; crea/actualiza el `ADMIN` y emite JWT propio.
7. El navegador guarda JWT/perfil Hermes en `sessionStorage`.

Brechas confirmadas:

- Admin mantiene OTPs en memoria; reinicios los eliminan y varias instancias no comparten estado.
- Hermes mantiene `jti` consumidos en un `Map`; reinicio/otra instancia no comparte la marca de consumo.
- No existe tabla/migración `CrmAuthProof`.
- `POST /api/auth/login` por contraseña sigue público; no es “sólo passwordless”.
- El nombre OTP está fijado como `Gerencia Undercodeec`; sólo el correo es configurable.

Antes de producción elegir:

1. **OTP único:** persistencia/Redis con consumo atómico y deshabilitar login por contraseña.
2. **OTP + emergencia:** restringir login por red/flag, contraseña segura y runbook de custodia.

La opción 1 coincide con el objetivo original.

## 9. Frontend confirmado

Rutas:

```text
/admin/crm
/admin/crm/login
/admin/crm/leads
/admin/crm/leads/[id]
/admin/crm/inbox
```

Incluye OTP, canje por JWT Hermes, sesión separada de `adminToken`, resumen, pipeline responsive, filtros, ficha de lead, inbox, historial, handoff, respuesta dentro de ventana, manejo de `401` y cliente centralizado en `src/lib/hermes/api.js`.

Variables públicas:

```env
NEXT_PUBLIC_HERMES_API_URL=/api/hermes
NEXT_PUBLIC_ADMIN_API_URL=https://api.undercodeec.com
```

Nunca colocar secretos con prefijo `NEXT_PUBLIC_`.

## 10. n8n, BullMQ y Telegram

```text
DomainEvent -> EventEmitter2 -> listener -> BullMQ `n8n-events`
-> Redis -> N8nDispatcher -> POST HMAC -> n8n -> Telegram
```

| Evento | Estado real |
|---|---|
| `lead.qualified` | Emisor/listener confirmados; ruta `/webhook/lead-qualified`; workflow/Telegram reportados. |
| `conversation.handoff_requested` | Emisor/listener confirmados; ruta `/webhook/handoff-requested`; workflow/Telegram reportados. |
| `lead.created` | Se emite/encola, no tiene ruta y el processor lo descarta. |
| `ping` | Endpoint/listener temporal y fallback `/webhook/ping`; reportado como probado. |
| `conversation.stalled` | Sólo resolución opcional de ruta; sin emisor/listener/workflow confirmado. |
| `task.followup_due` | Sólo resolución opcional de ruta; sin flujo completo. |
| `quote.requested` | Sólo resolución opcional de ruta; sin flujo completo. |
| `payment.intent_detected` | Sólo resolución opcional de ruta; sin flujo completo. |

Payloads de lead/handoff incluyen nombre, `waId` y `crmUrl`. No hay prueba actual de que los workflows productivos usen esos campos.

BullMQ tiene reintentos/backoff, pero falta prueba real apagando n8n, alertas de jobs fallidos y outbox transaccional. Un evento sin ruta se descarta deliberadamente.

## 11. Evidencia de producción

### Reportado el 2026-07-21

- Número productivo: `+593 99 973 9534`.
- Phone Number ID: `1165050173367575`.
- WABA: `2801579790209232`.
- App suscrita al WABA correcto.
- Mensaje real recibido, respuesta Gemini enviada por Meta y estados `sent`/`read` recibidos.

Esto prueba el núcleo conversacional en esa fecha, no el despliegue posterior del CRM.

### No verificado el 2026-08-02

- Contenedores, Nginx, certificado, DNS y commit desplegado.
- Migración `20260728150000_crm_consolidation` en producción.
- Variables CRM, CORS y proxy `/api/hermes` productivos.
- Build frontend desplegado y acceso OTP real.
- Texto/enlaces actuales de Telegram y estado de workflows.
- CRM → respuesta humana real por Meta.

Estado productivo del CRM: **no confirmado**.

## 12. Verificaciones del 2026-08-03

| Componente | Verificación | Resultado |
|---|---|---|
| Backend | `npm test -- --runInBand` | 4 suites, 11/11 pruebas. |
| Backend | `npm run test:e2e -- --runInBand` | 1 suite, 10/10 pruebas. |
| Backend | `npm run build` | Correcto. |
| Backend | `npx prisma validate` | Esquema válido. |
| Frontend CRM | ESLint focalizado | Correcto. |
| Admin OTP | `npm run test:crm-auth` | 3/3 pruebas. |
| Git frontend | Hashes CRM/OTP/Nginx/env vs `origin/main` local | Coinciden. |

No se ejecutó build completo Next.js: el árbol web compartido contiene muchos cambios ajenos. Las E2E backend usan servicios simulados y no sustituyen PostgreSQL/Meta/correo/n8n/Telegram reales.

## 13. Matriz de estado

| Área | Estado |
|---|---|
| Backend CRM | **Confirmado local/publicado** (`1406545`, `4a5362e`). |
| Migración CRM | **Confirmada en repo; producción no confirmada**. |
| UI CRM | **Confirmada en `origin/main`** (`ae280ed`, merge `139ca8a`). |
| OTP Admin | **Confirmado en código** (`9e1e6e9`). |
| Canje OTP Hermes | **Confirmado con brecha de persistencia**. |
| WhatsApp automático | **Reportado productivo 2026-07-21**. |
| Lead/handoff → n8n | **Código confirmado; producción reportada**. |
| CRM desplegado | **Pendiente/no confirmado**. |
| Respuesta humana real E2E | **Pendiente**. |
| Resiliencia n8n/BullMQ | **Pendiente**. |
| Plantillas fuera de 24 h | **Fuera del MVP actual**. |
| Etapas n8n 4–6 | **Pendientes**. |

## 14. Riesgos y deuda priorizada

### P0 — antes de exponer CRM

1. Desplegar desde ramas limpias y confirmar commits.
2. Respaldar y aplicar la migración CRM.
3. Endurecer Compose/red:
   - PostgreSQL usa `hermes_password` y publica `5432:5432`.
   - Redis publica `6379:6379` sin contraseña en Compose.
   - n8n contiene `hermes_n8n_admin_change_me` y usa imagen `latest`.
   - Rotar credenciales, fijar versión, retirar/bindear puertos a `127.0.0.1` y comprobar firewall.
4. Resolver persistencia/política OTP y login por contraseña.
5. Configurar secretos reales fuera de Git, con permisos restrictivos.
6. Validar proxy y CORS.
7. Ejecutar OTP → CRM → WhatsApp → n8n/Telegram → respuesta humana.

### P1 — cierre operativo

1. Actualizar workflows para `contactName`, `waId`, `crmUrl`.
2. Probar caída/reinicio de n8n y recuperación única de BullMQ.
3. Añadir observabilidad de jobs fallidos.
4. Eliminar/formalizar `/internal/test-event`.
5. Build Next.js desde copia limpia de `origin/main`.
6. Versionar este documento mediante excepción al `*.md`.
7. Limpiar ramas locales sólo tras preservar cambios ajenos.

### P2 — evolución

Plantillas WhatsApp, etiquetas relacionales, follow-ups/stalled, eventos quote/payment, múltiples operadores, tiempo real y outbox si la criticidad lo exige.

## 15. Variables requeridas

No copiar secretos a documentación ni Git.

### Hermes

```env
NODE_ENV=production
PORT=3003
DATABASE_URL=postgresql://<usuario>:<clave>@postgres:5432/hermes_db
REDIS_URL=redis://redis:6379
JWT_SECRET=<secreto-independiente>
JWT_EXPIRATION=8h
CRM_HERMES_PROOF_SECRET=<secreto-compartido-32+-bytes>
CRM_OPERATOR_EMAIL=<CONFIGURADO>
CRM_BASE_URL=https://undercodeec.com/admin/crm
CORS_ORIGINS=https://undercodeec.com
META_PHONE_NUMBER_ID=<id>
META_ACCESS_TOKEN=<secreto>
META_APP_SECRET=<secreto>
META_WEBHOOK_VERIFY_TOKEN=<secreto>
META_API_VERSION=<version-validada>
HERMES_API_URL=https://generativelanguage.googleapis.com/v1beta/openai/
HERMES_API_KEY=<secreto>
HERMES_MODEL=<modelo-validado>
N8N_INTEGRATION_ENABLED=false
N8N_BASE_URL=http://n8n:5678
N8N_HMAC_SECRET=<secreto-distinto>
N8N_CALLBACK_TOKEN=<secreto-distinto>
N8N_WEBHOOK_LEAD_QUALIFIED=/webhook/lead-qualified
N8N_WEBHOOK_HANDOFF_REQUESTED=/webhook/handoff-requested
LEAD_QUALIFICATION_INTENTS=consulta_precio,agendar_cita,cotizacion,pago
HANDOFF_INTENTS=solicitud_humano,queja,reclamo,pago_fallido,negociacion_especial,error
HANDOFF_KEYWORDS=<csv-validado>
```

Mantener `N8N_INTEGRATION_ENABLED=false` hasta probar secreto, paths y workflows.

### Admin

```env
CRM_OTP_HASH_SECRET=<secreto-independiente-32+-bytes>
CRM_HERMES_PROOF_SECRET=<mismo-secreto-compartido>
CRM_OTP_TTL_MS=600000
CRM_OTP_COOLDOWN_MS=60000
CRM_OTP_MAX_ATTEMPTS=5
CRM_OTP_IP_MAX_REQUESTS=5
```

### Next.js

```env
NEXT_PUBLIC_HERMES_API_URL=/api/hermes
NEXT_PUBLIC_ADMIN_API_URL=https://api.undercodeec.com
```

## 16. Runbook de despliegue pendiente

Confirmar rutas/nombres reales antes de ejecutar. No reemplazar Nginx a ciegas.

### Precondiciones

- SSH/sudo autorizado y ventana acordada.
- Copias limpias en `main`.
- Respaldo PostgreSQL verificable.
- Secretos preparados y seguridad Compose corregida.

### Actualizar

```bash
git -C <WEB_REPO> fetch origin
git -C <WEB_REPO> checkout main
git -C <WEB_REPO> pull --ff-only origin main
git -C <WEB_REPO> rev-parse --short HEAD

git -C <HERMES_REPO> fetch origin
git -C <HERMES_REPO> checkout main
git -C <HERMES_REPO> pull --ff-only origin main
git -C <HERMES_REPO> rev-parse --short HEAD
```

Esperado como mínimo:

```text
Web:    139ca8a o descendiente que conserve CRM
Hermes: 4a5362e o descendiente que conserve CRM/crm-proof
```

### Backend

```bash
cd <HERMES_REPO>/hermes-backend
test -f .env && chmod 600 .env
docker compose config
docker compose build app
docker compose up -d postgres redis n8n

mkdir -p <BACKUPS>
docker compose exec -T postgres pg_dump -U <USUARIO_DB> hermes_db \
  | gzip > <BACKUPS>/hermes-$(date +%F-%H%M).sql.gz

docker compose run --rm --no-deps app npx prisma migrate deploy
docker compose up -d app
docker compose ps
docker compose logs --tail=100 app
```

No crear usuario con contraseña si OTP será el único acceso. Si se mantiene acceso de emergencia, crearlo fuera del historial y documentar custodia/rotación.

### Frontend/proxy

```bash
cd <WEB_APP>
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Reiniciar con el gestor existente. Incorporar `/api/hermes/` en el servidor HTTPS actual y validar:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -fsSIL https://undercodeec.com/admin/crm/
curl -fsSIL https://undercodeec.com/api/hermes/docs
```

### n8n

Confirmar workflows activos, probar HMAC sin registrar secretos, actualizar mensajes CRM, probar primero con integración desactivada y vigilar app/Redis/n8n/Telegram al activar.

## 17. Aceptación productiva

1. Abrir `/admin/crm` sin fallos de assets/proxy.
2. Solicitar/recibir OTP; verificar una vez y rechazar reuso.
3. Confirmar que el navegador conserva sólo JWT Hermes.
4. WhatsApp nuevo: un contacto, conversación, lead `NEW` e inbound.
5. Confirmar respuesta automática guardada y entregada.
6. Intención comercial: mismo lead a `QUALIFIED`, una ejecución n8n y un Telegram con enlace correcto.
7. Solicitud humana: `HANDED_OFF`, alerta y sin respuesta automática posterior.
8. Abrir enlace, tomar conversación y responder desde CRM dentro de 24 h.
9. Comprobar `HUMAN`, `sentByUserId`, `wamid` y entrega.
10. Resolver/devolver/cerrar y comprobar estados.
11. Fuera de 24 h: texto libre bloqueado con `WHATSAPP_TEMPLATE_REQUIRED`.
12. Detener n8n en ventana controlada, generar evento, levantar y confirmar una sola entrega recuperada.
13. Revisar logs, duplicados, 5xx y jobs fallidos.

Guardar fecha, commits e IDs enmascarados. Dos conversaciones controladas consecutivas deben pasar.

## 18. Invariantes

- PostgreSQL es la fuente de verdad; n8n no decide estado oficial.
- Un contacto no recibe un lead por mensaje; calificar no duplica.
- Handoff abierto mantiene control humano hasta decisión explícita.
- No texto libre fuera de 24 horas.
- UI sin acceso directo a DB, Meta, Gemini, n8n o secretos.
- No WhatsApp Web/scraping no oficial.
- No tokens, OTPs, chats o payloads sensibles en docs/logs.
- No desplegar árboles con cambios ajenos sin aislarlos.

## 19. Documentos consolidados

| Documento anterior | Motivo de retiro |
|---|---|
| `contexto-crm-whatsapp-hermes.md` | Correcto en julio, pero anterior a funciones CRM posteriores. |
| `contrato-api-crm-hermes.md` | Contrato parcial con auth/pruebas ya superadas. |
| `estado-proyecto.md` anterior | Era el más cercano, pero omitía brechas OTP/Compose y niveles de evidencia. |
| `guia-hermes-vps-meta-whatsapp.md` | Guía inicial obsoleta con marcadores de citas inválidos. |
| `HERMES_CRM_PASSWORDLESS_AUTH_STATUS.md` | Decía que Hermes OTP estaba pendiente; lo superó `4a5362e`. |
| `integracion-n8n-backend-hermes.md` | Decía que n8n no estaba integrada. |
| `logs.md` | Duplicado transitorio del bloqueo de permisos. |
| `plan-desarrollo-crm-hermes-kommo.md` | Mezclaba plan, checklist y estado. |
| `plan-integracion-n8n-backend-hermes.md` | Bitácora de 1.066 líneas con estados intermedios e IDs reemplazados. |

## 20. Próxima acción

No añadir más funciones todavía:

1. preparar copias limpias de `main`;
2. corregir seguridad Compose y persistencia/política OTP;
3. respaldar y aplicar migración CRM;
4. desplegar backend, frontend y proxy;
5. actualizar n8n/Telegram;
6. ejecutar toda la aceptación de la sección 17;
7. registrar aquí fecha y evidencia.

Después: plantillas, etiquetas, follow-ups o múltiples operadores.

## 21. Diagnóstico del flujo de desarrollo

```text
Implementación local y versionada
        ↓
Hardening de seguridad y decisiones operativas
        ↓
Despliegue reproducible en VPS
        ↓
Pruebas de aceptación con Meta, correo, n8n y Telegram
        ↓
Operación controlada del MVP
        ↓
Evolución funcional
```

### Fase actual: cierre técnico del MVP

El núcleo del producto está construido: persistencia CRM, APIs protegidas, procesamiento de conversaciones de WhatsApp, clasificación comercial, handoff humano, interfaz de operador y notificaciones asíncronas. Las pruebas locales de backend ejecutadas el 2026-08-03 confirman que la base de código compila y que sus suites unitarias y E2E simuladas pasan.

El trabajo no debe avanzar aún hacia nuevas capacidades. Antes corresponde cerrar los riesgos que impedirían una operación segura y verificable:

1. endurecer Compose, red y credenciales;
2. decidir y persistir la política de OTP, incluido el tratamiento del login por contraseña;
3. desplegar backend, migración, frontend y proxy desde copias limpias de `main`;
4. confirmar los workflows de n8n/Telegram y las variables de entorno;
5. ejecutar y registrar la aceptación productiva de la sección 17.

Al superar esa aceptación, Hermes pasará de **MVP implementado pendiente de despliegue** a **MVP operativo validado**. Sólo entonces conviene priorizar las mejoras P1/P2: plantillas de WhatsApp, observabilidad de colas, etiquetas, follow-ups, eventos comerciales, tiempo real o soporte para varios operadores.

## 22. Campañas oficiales de WhatsApp Cloud API — actualización 2026-09-03 (America/Guayaquil)

Commits relevantes: `44feef4 feat(campaigns): add official WhatsApp template campaigns`, `09d38bc fix(campaigns): prevent duplicate sends on ambiguous retries` y `26891a3 fix(campaigns): route campaign replies to human handoff`.

### Implementado localmente

- Modelos Prisma `Campaign`, `CampaignRecipient` y consentimiento de marketing en `Contact`, con migraciones `20260903143000_whatsapp_campaigns` y `20260903160000_campaign_send_idempotency`.
- Endpoints CRM protegidos para plantillas aprobadas de WABA, campañas, destinatarios, importación JSON por lotes y acciones explícitas de inicio, pausa, reanudación y cancelación.
- Normalización E.164 para Ecuador, importación que no crea Leads, consentimiento explícito y baja por Quick Reply de Meta.
- Una respuesta de un destinatario de campaña se guarda en Inbox, se marca como `REPLIED` y abre un handoff `CUSTOM` para atención humana; Hermes no se invoca ni genera/envía una respuesta automática. La baja por Quick Reply conserva su flujo de `OPTED_OUT` sin abrir el handoff.
- Cola BullMQ independiente, limitada por configuración; reclama atómicamente el destinatario antes de Meta y no reintenta resultados ambiguos para evitar duplicados.
- Persistencia de `wamid`, estados de webhook idempotentes y métricas de campañas; Meta se usa solamente desde `MetaService`.
- Actualización 2026-09-04 (America/Guayaquil), aún sin commit: biblioteca de videos de campaña. Un operador puede cargar un MP4 (máximo 16 MB) desde el CRM; Hermes lo carga al número de WhatsApp mediante Meta y guarda el `Media ID` en PostgreSQL. También puede registrar una vez un `Media ID` existente: Hermes lo verifica contra el WABA configurado antes de guardarlo. Las campañas seleccionan el video de la biblioteca y no requieren copiar IDs ni cambiar `.env`.

### Seguridad, validación y pendiente

- Nuevas variables sin valores secretos: `META_WABA_ID`, `CAMPAIGNS_ENABLED=false`, `CAMPAIGN_SEND_RATE_PER_SECOND=2`, `CAMPAIGN_MEDIA_ALLOWED_HOSTS`.
- Verificación adicional de `26891a3`: `npm test -- --runInBand webhook.service.spec.ts campaigns.service.spec.ts` (2 suites, 5/5 pruebas) y `npm run build`: aprobados localmente. La nueva prueba confirma que una respuesta de campaña no llama a Hermes ni a `MetaService.sendTextMessage`.
- Verificación de la biblioteca multimedia 2026-09-04: `npm test -- --runInBand campaigns.service.spec.ts` (1 suite, 5/5) y `npm run build` en `hermes-backend`; `npm run build` en `undercodeec_nextjs`: aprobados. Falta aplicar la migración `20260904100000_campaign_media_library`, desplegar ambos servicios y realizar la prueba controlada.
- `26891a3` fue publicado en `origin/main`; no existe evidencia VPS posterior de su despliegue. No se ha enviado ningún WhatsApp real. Pendiente: desplegarlo, migración autorizada, WABA/allowlist, verificar Quick Reply real y prueba controlada con un único contacto `OPTED_IN`.

## 23. Política documental

Cada actualización debe incluir fecha/zona, commits, evidencia confirmada vs reportada, comandos/conteos, cambios productivos sin secretos y pendientes priorizados.

**No crear nuevos Markdown en esta carpeta. Actualizar este archivo y eliminar información superada.**
