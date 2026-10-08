# Estado del proyecto Hermes CRM

> **Corte documental:** 2026-10-05, `America/Guayaquil`.
>
> **Backend revisado:** `D:/Documentos/Hermes`, rama `main`, HEAD `cfbd00ca8979f84499745d2ac4afdc25139f6af5` (un commit por delante de `origin/main` local). **Web/Admin asociado:** `D:/Documentos/undercodeec_nextjs`, rama `main`, HEAD `f511eb2e6ec16ab4b4040392bdea06957e09afb7`.
>
> Este es el estado consolidado de Hermes en `ProyectMD/`. Sustituye las afirmaciones antiguas de este archivo. Los planes y runbooks temáticos conservan detalles, pero algunos describen etapas ya superadas. Un commit, prueba local o pantalla no acredita por sí solo un despliegue productivo.

## Actualización del 08/10/2026 — Fase 0 y control humano

El corte local del 05/10 de las secciones siguientes sigue siendo histórico. La auditoría posterior del entorno servido y sus límites están en [hermes-learning-loop-plan.md](../hermes-backend/docs/hermes-learning-loop-plan.md). La release web observada el 08/10 fue `94882e9`; el SHA exacto del backend servido continúa sin identificarse. La Fase 0 permanece abierta por backups/restauración, capacidad bajo carga y evaluación sintética de la salida final.

En el checkout local se implementó el bloque de Fase 0A «Tomar control humano» en Inbox y el control de propiedad/ventana en la API. Se verificaron compilaciones de ambos repositorios, ESLint dirigido y 37 pruebas dirigidas de Hermes. No se desplegó ni se envió un mensaje real; la corrección de etapa y la auditoría del caso concreto siguen pendientes. El plan enlazado registra el alcance y los criterios de cierre.

## 1. Dictamen y evidencia

Hermes es un CRM conversacional sobre WhatsApp Cloud API: NestJS procesa mensajes y reglas, PostgreSQL guarda el estado oficial, Redis/BullMQ coordina guardas y entregas, Next.js ofrece el espacio del operador y n8n/Telegram comunica eventos auxiliares. Desde el corte anterior se incorporaron motor conversacional intercambiable, turnos entrantes y entregas durables, voz, autoridad comercial en base de datos, Google Meet, atribución publicitaria ampliada y transferencias revisadas en el Inbox.

**Estado al corte:** estas capacidades existen en el código inspeccionado. Hay pruebas locales documentadas; **no hay certificación E2E integral del conjunto desplegado**. La última observación externa registrada (04/10) confirma `hermes-app` en `127.0.0.1:3003`, pero no identifica su imagen/SHA, flags ni migraciones aplicadas. Por ello no se declara que `cfbd00c` o los pagos Hermes estén en producción. Los valores iniciales versionados mantienen apagados campañas, Google Ads, Calendar y transferencias; el valor efectivo del VPS debe verificarse sin exponer secretos.

| Nivel | Criterio |
|---|---|
| Implementado | Código, modelo, migración o interfaz presentes en el checkout citado. |
| Probado localmente | Comando y resultado fechados; se distingue uso de dobles o servicios temporales. |
| Reportado en producción | Bitácora fechada del operador o del repositorio web, sin revalidación en este corte. |
| Certificado E2E | Recorrido real con servicios, datos, permisos, efectos secundarios y recuperación comprobados. |

**Verificación local reproducida el 05/10 en `hermes-backend`:** `npm test -- --runInBand` pasó 56 suites y 959 pruebas, sin fallos; `npm run build` terminó con código 0; `npx prisma validate` confirmó esquema válido. Son pruebas locales y no usaron Meta, Google ni la base productiva. El conteo de 947 pruebas citado por el plan de pagos corresponde al 02/10 y queda reemplazado para el HEAD actual por las 959 de este corte.

## 2. Repositorios y estado operativo

| Componente | Estado del checkout | Última evidencia de producción |
|---|---|---|
| Hermes backend | `cfbd00c` del 02/10; árbol limpio antes de esta edición; migraciones versionadas hasta `20261002000000_transfer_payments`. | `hermes-app` en loopback :3003 según registro del 04/10; imagen/SHA y esquema efectivos no identificados. |
| Web/Admin UnderCodeEC | `f511eb2` del 04/10; pantallas CRM para Inbox, calendario, campañas, publicidad y administración; proxy `/api/hermes/[...path]`. Hay cambios locales ajenos que se preservan. | Release web `3ca3a8e` reportada activa el 04/10; refinamiento de login `f511eb2` sin despliegue confirmado. |
| API Express administrativa | Provee OTP/sesión de Admin, pagos y datos propios de la web. Es un proceso y base distintos de Hermes. | `api-undercodeec` online en :3002 el 04/10, sin SHA de proceso documentado. |

Web, Express y Hermes se actualizan por separado. Un build web o `/api/docs` HTTP 200 no demuestra que sus rutas autenticadas, workers, Meta, Calendar o Google Ads funcionen juntos. Las transferencias bancarias de Hermes en Inbox no son el mismo circuito de órdenes por transferencia de la portada/Express.

## 3. Arquitectura vigente

```text
WhatsApp -> Meta Cloud API -> webhook NestJS
                           |-> PostgreSQL: contacto, lead, turno, mensaje,
                           |   conversación, cita, pago y auditoría
                           |-> Redis/BullMQ: guardas, inferencia y entregas
                           |-> Gemini directo o Nous Hermes privado
                           |-> Meta: texto, audio o plantilla
                           `-> n8n (HMAC) -> Telegram

Operador -> Next.js /admin/crm -> /api/hermes/* -> Hermes /api/*
Sitio público -> BFF atribución -> referencia UC-... -> WhatsApp -> webhook
                                                    `-> Data Manager/Ads con gates
Calendar OAuth -> Google Calendar/Meet -> Meeting/Task/AutomatedDelivery
```

`hermes-backend/docker-compose.yml` enlaza app, PostgreSQL, Redis y n8n a `127.0.0.1`; sólo `app` entra además a la red privada `hermes_client_api` para Nous. Compose carga credenciales desde archivos externos; el Bearer de Nous usa Docker secret y ADC de Google se monta en sólo lectura. `.env.example` es catálogo de nombres y valores iniciales, no configuración efectiva. El runbook VPS del 22/09 es histórico respecto a migraciones posteriores.

## 4. CRM, acceso y atención humana

- Backend: NestJS 11, TypeScript, Prisma/PostgreSQL, JWT/roles, Swagger `/api/docs`, Redis/BullMQ, Meta y n8n. `AppModule` integra Auth, Webhook, CRM, Campaigns, Advertising, GoogleCalendar y Payments.
- Frontend: resumen, pipeline/leads, Inbox, calendario, campañas, publicidad y administración. El proxy web usa `/api/hermes`; su destino privado debe incluir la base `/api` de Hermes. El registro web indica que `/admin/*` se sirve sólo en `admincrm.undercodeec.com`.
- OTP: Admin solicita y verifica un código de ocho dígitos, entrega una prueba breve a `POST /api/auth/crm-proof` y conserva una sesión administrativa distinta; Hermes emite su JWT. Sigue público `POST /api/auth/login` con contraseña. Los OTP de Admin y los `jti` consumidos de Hermes dependen de memoria de proceso; no existe `CrmAuthProof` en Prisma. Faltan canje completo, expiración, reuso, roles y reinicios con ambos servicios reales.
- Conversaciones: se reutiliza un lead abierto por contacto. Un handoff abierto conserva control humano. La UI permite tomar/resolver, responder dentro de la ventana de 24 horas, cerrar y reabrir. `GET /api/conversations/events` expone SSE protegido; el cliente reconecta y usa sondeo de respaldo. Falta validar el stream por proxy/Nginx en la release servida.
- Fuera de 24 horas, texto libre devuelve `WHATSAPP_TEMPLATE_REQUIRED`. Las campañas usan plantillas oficiales; una respuesta de campaña abre atención humana, sin respuesta automática de Hermes.

## 5. Conversación, voz y entrega segura

Cambios representativos: `b7ee63e`, `d500c3d`, `b63af41`, `800f5b9`, `6457097`, `769d1ab`, `c033b1b` y `f4e0f14`.

1. El webhook verifica la firma HMAC de Meta sobre el cuerpo crudo y evita reprocesar `wamid`. `MetaWebhookInbox` aporta recepción persistente. La guarda Redis limita frecuencia, spam, tamaño y cuotas antes de consumir IA; el valor inicial es `AI_GUARD_FAIL_CLOSED=true`. Un problema técnico atribuido expresamente a la marca abre handoff `SUPPORT`.
2. Mensajes cercanos forman un `InboundTurn`, con debounce/espera máxima configurables y recuperación de turnos pendientes. La política revisa la salida antes de Meta, divide respuestas largas y ordena sus partes. `AutomatedDelivery` es el ledger durable: reserva antes del envío y distingue el resultado ambiguo para no duplicar por reintento. Hay pruebas de coordinación distribuida.
3. El motor predeterminado es `gemini_direct`. `nous_hermes` usa un contrato JSON y endpoint fijo en la red privada; se selecciona por allowlist de UUID de conversación o `NOUS_HERMES_OPEN_INBOUND_TEST=true`. Hermes valida propuestas y evidencia antes de cambiar estado; el agente no ejecuta acciones por sí mismo. Redis/BullMQ serializa inferencias. No hay prueba en este corte de que Nous esté activo en producción.
4. Las notas de voz entrantes pueden transcribirse; las respuestas pueden sintetizarse y enviarse con la API oficial. STT/TTS admiten ElevenLabs y alternativa OpenAI, límites de bytes/duración y fallback a texto. Los fixes del 23–24/09 cubren multipart/Opus y diagnósticos seguros. Falta un recorrido real de audio, fallback y costos.
5. `Product`/`PriceList` en PostgreSQL autorizan precios y ofertas. Migraciones del 23/09 añaden autoridad por mercado y nueve tarifas globales iniciales en USD con IVA incluido. Un cambio administrativo de precio se consulta de nuevo en el siguiente turno. La revisión comercial elimina importes/promociones no autorizados; `commercial-catalog.ts` queda como artefacto de reversión, no fuente activa.

La corrección comercial del 29/09 añadió regresiones para distinguir pagos del comprador y del proyecto, reconocer consultas de precio y plazo, rechazar importes/IVA/modalidades no autorizados y resolver preguntas pendientes sólo tras confirmar la parte pertinente de una entrega. Su informe registró 50 suites/765 pruebas unitarias y 12 E2E locales en ese checkout; el conteo vigente de unitarias es el de la sección 1. Persisten la evaluación conversacional con proveedores reales y la integración PostgreSQL/Redis de estos flujos. Los lotes de entrega creados antes de los metadatos nuevos no se reconstruyen retroactivamente al recuperarse; revisar su estado antes de cualquier reintento operativo.

La reducción real de duplicados y la recuperación ante fallos de Redis/Meta requieren observación en el entorno servido; las pruebas sintéticas no las certifican por sí solas.

## 6. Campañas oficiales de WhatsApp

- Prisma modela `Campaign`, `CampaignRecipient`, consentimiento, `CampaignMedia` y `CampaignTemplateMedia`. La UI obtiene plantillas aprobadas, carga/registra MP4 hasta 16 MB, reutiliza multimedia y previsualiza/importa CSV con control de duplicados y consentimiento. Importar no inicia una campaña.
- La API `/api/campaigns` permite plantillas/media, campañas/destinatarios y acciones explícitas de iniciar, pausar, reanudar y cancelar. El worker BullMQ limita tasa, reclama destinatarios antes de Meta y persiste `wamid`/estados. Quick Reply de baja marca `OPTED_OUT`; una respuesta normal se deriva a humano.
- `CAMPAIGNS_ENABLED=false` es el valor inicial. No consta aceptación productiva con un destinatario `OPTED_IN`, plantilla aprobada, respuesta, baja y métricas. Confirmar aplicación de `20260903*`, `20260904100000_campaign_media_library` y `20260907110000_campaign_template_media` antes de operar.

## 7. Atribución, consentimiento y Google Ads

La web recoge `gclid`/`gbraid`/`wbraid`, UTM y `utm_id` bajo consentimiento. Su BFF pide a `POST /api/advertising/contact-intents` una referencia opaca `UC-...`. El clic no crea un lead atribuido: el touch se confirma únicamente cuando el webhook de Meta recibe la referencia en un mensaje real. El primer touch confirmado de la oportunidad gobierna hitos; los posteriores permanecen en historial. Existen revocación, auditoría, idempotencia y API JWT para dashboard, estado, mapeos, historial y métricas.

Las migraciones `20260917123000_advertising_attribution`, `20260929120000_attribution_v2_utm_id`, `20260929233000_advertising_destination_snapshot` y `20261001120000_advertising_conversion_customer` amplían el contrato. El código separa cuenta operativa Ads, MCC de acceso y `conversionCustomerId` propietario de la acción; guarda snapshot de destino por trabajo. Data Manager usa `events:ingest`, `transactionId` estable y diagnóstico `requestStatus:retrieve`. `SUBMITTED` no equivale a `ACCEPTED`. `f4e0f14` añadió reconciliación y pruebas de flujo/outbox; el panel web ya muestra las tres cuentas.

**Evidencia externa:** el 17/09 se reportó ADC de la identidad existente en `hermes-app`, GAQL de sólo lectura HTTP 200 y mapeo secundario `LEAD_QUALIFIED` a una acción `UPLOAD_CLICKS`. Eso prueba acceso de lectura entonces; no acredita `validateOnly`, ingesta aceptada, métricas sincronizadas ni la migración de `conversionCustomerId` en producción. El reporte web del 01/10 mantiene flags Google apagados y no documenta una prueba Data Manager real. Antes de enviar: verificar dueño de acción, destino, consentimiento, migraciones, credenciales/roles y lead control elegible. El código exige integración/mapeo y flags `ADVERTISING_GOOGLE_SYNC_ENABLED`/`ADVERTISING_GOOGLE_SEND_ENABLED`; con `SEND=false` valida sin envío real. Métricas tienen gate independiente `ADVERTISING_GOOGLE_METRICS_ENABLED`.

## 8. Google Calendar y Meet

- `533a0bf`, `93426c0` y `cc7d88e` incorporan `Meeting`/`MeetingOperation`, OAuth/Calendar, disponibilidad, Meet, reprogramación/cancelación y `GET /api/meetings` protegido para el CRM. Las operaciones durables coordinan reintentos/reconciliación; confirmación y tarea `APPOINTMENT` dependen del estado persistido.
- Se pide ubicación cuando falta. Ecuador continental y España (península/Baleares o Canarias) usan zonas IANA; las propuestas de 15 minutos respetan horario regional, duración y buffer. La UI muestra zonas y DST. Un enlace Meet pendiente permanece en verificación. El runbook temático detalla OAuth y límites de concurrencia.
- La bitácora del 26/09 reporta una **aceptación real local**: OAuth de una cuenta de prueba, FreeBusy, creación y lectura de un evento Meet, reintento idempotente, reprogramación, cancelación y limpieza de Meeting/Task. `20260926173000_google_calendar_meetings` se aplicó sólo a PostgreSQL local; no se envió WhatsApp real. Esa cuenta estaba en OAuth External/Testing, por lo que no se debe asumir que el token local siga vigente.
- `GOOGLE_CALENDAR_ENABLED=false` en el ejemplo. No consta autorización OAuth/refresh token operativo, migración ni recorrido real de reserva/cancelación en VPS. Falta revisar datos reales, accesibilidad y zonas en la release servida.

## 9. Transferencias bancarias en el Inbox

`9c32ec6` añadió `BankAccount`, `TransferPayment` y `TransferPaymentProofMessage`; `cfbd00c` preserva la referencia WhatsApp de un comprobante multimedia para atribución. La migración es `20261002000000_transfer_payments`. Valores iniciales: `PAYMENTS_TRANSFER_ENABLED=false` y clave de cifrado vacía.

- Sólo ADMIN administra cuentas; el número se cifra en reposo, se enmascara al listar y una transferencia conserva snapshot. Una política determinista exige intención y contexto comercial antes de ofrecer datos. Se crea/reutiliza un intento, el lead pasa a `PAYMENT_PENDING` y se registran instrucciones.
- Un comprobante `IMAGE`/`DOCUMENT` se vincula idempotentemente por `messageId` a su conversación, lleva a `PAYMENT_REVIEW` y genera tarea `PAYMENT_VERIFICATION`. El archivo permanece en Meta/Inbox: `GET /api/conversations/:id/messages/:messageId/media` requiere JWT/rol, verifica pertenencia y responde `inline` sin caché. Hermes no guarda copia del archivo.
- `/api/transfers/conversation/:id` y `/api/transfers/:id` exponen estado; `start-review` toma revisión. Sólo ADMIN aprueba/rechaza. Aprobar exige el mensaje revisado y control de estado; mueve el lead a `WON` y registra el hito. Recibir el archivo nunca equivale a aprobación.
- El cliente web `49d343c` incorpora revisión en Inbox. El plan temático registra el 02/10 56 suites/947 unitarias backend, migraciones sobre bases temporales y 32 pruebas frontend dirigidas; también indica que la base principal no se migró ni hubo prueba Meta real. Son resultados históricos del plan, no una ejecución de este corte. La conciliación con las órdenes Express sigue pendiente.

## 10. Esquema, rutas y controles

Hay **19 migraciones versionadas** desde `20260628184421_init` hasta `20261002000000_transfer_payments`. Tras CRM/campañas se añadieron guardas/soporte, atribución, ledger de entregas, precios, turnos entrantes, Meet, ampliaciones Ads, inbox durable de Meta y pagos. El esquema incluye `AdvertisingIntegration` y sus entidades de touch/conversión/job/métrica, `InboundTurn`, `MetaWebhookInbox`, `AutomatedDelivery`, `Meeting`, `MeetingOperation` y los tres modelos de transferencias. Una migración presente en Git **no demuestra** que esté aplicada en la base principal. El runbook 22/09 terminaba en `20260921170000_automated_delivery_ledger` y debe reconciliarse con las posteriores.

| Secuencia | Migraciones versionadas | Alcance |
|---|---|---|
| Base CRM | `20260628184421_init`, `20260728150000_crm_consolidation` | Entidades iniciales, leads y operación CRM. |
| Campañas | `20260903143000_whatsapp_campaigns`, `20260903160000_campaign_send_idempotency`, `20260904100000_campaign_media_library`, `20260907110000_campaign_template_media` | Destinatarios, envío seguro y multimedia. |
| Protección y publicidad inicial | `20260916170000_conversation_guard_support`, `20260917123000_advertising_attribution` | Soporte, atribución y conversiones. |
| Conversación comercial | `20260921170000_automated_delivery_ledger`, `20260923010000_commercial_market_authority`, `20260923020000_seed_global_commercial_prices`, `20260923160000_inbound_turns`, `20260925120000_commercial_plan_terms` | Entregas, ofertas autorizadas, agrupación y términos. |
| Calendar | `20260926173000_google_calendar_meetings` | Reuniones y operaciones durables. |
| Ads y webhook | `20260929120000_attribution_v2_utm_id`, `20260929180000_meta_webhook_inbox`, `20260929233000_advertising_destination_snapshot`, `20261001120000_advertising_conversion_customer` | `utm_id`, inbox Meta, destino y cuenta propietaria de conversión. |
| Pagos | `20261002000000_transfer_payments` | Cuentas, transferencias y referencias de comprobantes. |

| Dominio | Rutas principales | Control |
|---|---|---|
| Auth | `POST /api/auth/crm-proof`, `POST /api/auth/login`, `GET /api/auth/profile` | Canje/login públicos; perfil JWT. |
| CRM | `/api/leads`, `/api/conversations`, `/api/handoff`, `/api/tasks`, `/api/analytics/*` | JWT/roles; cierre, reapertura y respuesta humana. |
| Inbox | `GET /api/conversations/events` (SSE), `GET /api/conversations/:id/messages/:messageId/media` | JWT/roles; media sin caché. |
| Campañas | `/api/campaigns/*` | JWT/roles; flag y consentimiento para envío. |
| Publicidad | `POST /api/advertising/contact-intents`, `/api/advertising/*` | Clave servidor a servidor para referencia; panel JWT y cambios sensibles ADMIN. |
| Calendar | `GET /api/meetings` | JWT ADMIN/SALES_AGENT; bootstrap OAuth sólo local/desarrollo. |
| Pagos Hermes | `/api/bank-accounts`, `/api/transfers/*` | Cuentas ADMIN; lectura/revisión ADMIN/SALES_AGENT; decisiones ADMIN. |
| Meta | `GET/POST /webhooks/meta/whatsapp` | Verificación Meta y firma del POST. |

Persiste `POST /internal/test-event` protegido con token interno; decidir su retiro o formalización. Los roles técnicos son `ADMIN` y `SALES_AGENT`; no hay permisos finos para equipos múltiples.

## 11. Pendientes priorizados

### P0: identificar y aceptar lo servido

1. Registrar sin secretos SHA/digest de `hermes-app`, SHA de `api-undercodeec`, release/`BUILD_ID` web y `prisma migrate status` de la base principal. El registro del 04/10 identifica sólo la release web `3ca3a8e`.
2. Respaldar y ensayar restauración de PostgreSQL; aplicar migraciones pendientes y desplegar revisiones compatibles de Hermes y web por sus mecanismos separados. Conservar flags cerrados hasta sus pruebas controladas.
3. Certificar OTP con correo, dos sesiones, roles, expiración/reuso y reinicio. Resolver persistencia compartida y consumo atómico de OTP/`jti`; decidir login por contraseña de emergencia.
4. Recorrer con contacto autorizado WhatsApp texto/audio, handoff, respuesta humana, reapertura, SSE, n8n/Telegram, ventana de 24 horas y recuperación ante errores Meta/Redis. Registrar IDs enmascarados y duplicados.
5. Probar campaña de un destinatario `OPTED_IN` con plantilla/media aprobadas, pausa, respuesta humana y baja Quick Reply.
6. Probar Meet y transferencia Hermes en el entorno servido con servicios reales: idempotencia, permisos de media, DST, aprobación/rechazo y auditoría. Conciliar separadamente con pagos/órdenes de UnderCodeEC.
7. Cerrar gates Ads: dueño de acción, `conversionCustomerId`, consentimiento, touch confirmado, `validateOnly` real, diagnóstico de ingesta, métricas y decisión de activación. No inferir éxito de `SUBMITTED` ni de GAQL de lectura.
8. Antes de un canary de Nous, confirmar salud y contrato JSON desde el runtime servido, aislar conversaciones y comparar ambos motores con conversaciones ficticias o autorizadas, incluyendo calidad comercial, latencia, costos y ausencia de envíos duplicados.

### P1: operación y mantenimiento

- Definir alertas para webhook inbox, `InboundTurn`, `AutomatedDelivery`, BullMQ, citas pendientes, atribución y revisión de comprobantes; medir reintentos ambiguos y tiempos de atención.
- Repetir inventario de dependencias/vulnerabilidades: el `npm audit` del runbook 22/09 no prueba el lockfile actual. Mantener secretos, ADC, OAuth y clave de cifrado fuera de Git; comprobar red y volúmenes.
- Revisar accesibilidad/móvil de Inbox y calendario en la release activa. Preparar restauración y rollback por componente sin borrar datos de migraciones.
- Repetir con PostgreSQL/Redis de prueba las regresiones comerciales de pagos, precio/plazo y entregas parciales; reconciliar lotes históricos sin metadatos de resolución.

## 12. Documentos conservados y fuentes

En `ProyectMD/` permanecen dos referencias complementarias a esta guía:

| Documento | Uso vigente y límite |
|---|---|
| [hermes.md](hermes.md) | Casos de conversación, tono y criterios comerciales como referencia de producto. Es una solicitud del 19/09, no una lista de capacidades verificadas ni autoridad de precios; contrastar con código, catálogo y este estado. |
| [hermes-agent-vps-handoff.md](hermes-agent-vps-handoff.md) | Contrato privado, aislamiento y operación del agente Nous observados el 21/09. Es evidencia fechada; verificar runtime, imagen, red y secreto montado antes de utilizar sus comandos. El runbook actual del cliente CRM está en `hermes-backend/docs/nous-hermes-runbook.md`. |

Los planes de implementación, prompts de publicación, preflight e informes pre-commit de esta carpeta se retiraron tras incorporar sus resultados o pendientes relevantes. La prueba real local de Calendar se resume en la sección 8; su procedimiento vigente está en el runbook del backend. El estado productivo sólo puede actualizarse con evidencia nueva del entorno servido.

- Código: `hermes-backend/src`, `prisma/schema.prisma`, `prisma/migrations`, `docker-compose.yml`, `.env.example` e historial `git log` hasta `cfbd00c`.
- Backend: `hermes-backend/docs/google-calendar-runbook.md`, `nous-hermes-runbook.md`, `transfer-payment-crm-implementation-plan.md`, `deployment-vps-runbook-2026-09-22.md` y `security-preflight-2026-09-21.md`. Los resultados de prueba de cada uno conservan su propia fecha; los runbooks antiguos pueden contener pasos o enlaces superados.
- Web: `D:/Documentos/undercodeec_nextjs/ProyectoMD/estado-proyecto-sitiowebundercodeec.md` (corte 05/10) y su registro de despliegue del 04/10. Es evidencia reportada para producción, no inspección nueva del VPS en esta actualización.
- Cada siguiente corte debe registrar fecha/zona, SHA e imagen por proceso, migraciones aplicadas, flags sin valores sensibles, pruebas con conteos/entorno, recorrido E2E y pendientes. No incluir secretos, OTP, conversaciones ni estados Markdown paralelos en `ProyectMD/`.
