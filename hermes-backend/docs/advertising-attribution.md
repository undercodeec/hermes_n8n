# Publicidad y atribucion en Hermes

## Alcance

Esta implementacion pertenece exclusivamente a Hermes. No modifica los botones,
etiquetas, consentimiento, SEO ni componentes de UnderCodeEC, y tampoco modifica
la logica de campanas masivas de WhatsApp. La integracion extremo a extremo no se
considera validada hasta realizar una prueba controlada con ambos repositorios y
una cuenta de Google autorizada.

Estado por entregas:

- Entrega 1: backend de referencias y atribucion WhatsApp IMPLEMENTADO y PROBADO;
  captura web y prueba entre repositorios PENDIENTES.
- Entrega 2: modelo e hitos comerciales IMPLEMENTADOS y PROBADOS con mocks.
- Entrega 3: Data Manager API IMPLEMENTADO, PROBADO con mocks y DESPLEGADO; la
  primera validacion real contra Data Manager sigue PENDIENTE.
- Entrega 4: sincronizacion/cache y API de dashboard IMPLEMENTADOS y
  DESPLEGADOS; interfaz web, identidad ADC de produccion y validacion real
  PENDIENTES.

## Estado de la configuracion Google Cloud (2026-09-17)

La configuracion local de Hermes se ha comprobado de forma segura, sin revelar ni
guardar secretos en este repositorio:

- El proyecto de Google Cloud `p-key-8b551br5b9ig` tiene habilitadas Data Manager
  API y Google Ads API.
- Existe un cliente OAuth de escritorio para el uso local y ADC fue creado con
  `gcloud auth application-default login`, con los scopes `datamanager`,
  `adwords` y `cloud-platform`.
- La autenticacion ADC fue verificada contra Google Ads API con la consulta GAQL
  de solo lectura `customer_client`; respondio HTTP 200 para el MCC configurado.
  La prueba no envio cabecera `developer-token`.
- La cuenta objetivo, el MCC y el ID numerico de la accion de conversion ya fueron
  identificados por el operador. Esos identificadores deben permanecer en el
  gestor de secretos o en el entorno, nunca en Git.

Los Developer Tokens de Google Ads fueron retirados el 2026-09-09. Google Ads
ahora determina el nivel de acceso usando el proyecto de Google Cloud asociado a
las credenciales OAuth/ADC; una cabecera `developer-token` es opcional e
ignorada. Hermes no la exige ni la envia. Referencia vigente:

- https://developers.google.com/google-ads/api/docs/api-policy/developer-token

El acceso de la identidad local ya quedo demostrado. El operador tambien confirma
que ya existe una cuenta de servicio y que tiene acceso concedido dentro de
Google Ads; no se debe crear ni invitar una segunda cuenta. Falta verificar que
esa identidad existente tenga `Service Usage Consumer` en el proyecto, montarla
como ADC en la VPS y repetir la consulta GAQL desde el contenedor de produccion
sin exponer credenciales.

## Estado del despliegue de Hermes (2026-09-17)

El despliegue de la funcionalidad de atribucion fue completado en la VPS. La
version publicada contiene los commits `92c834f` (atribucion e integraciones) y
`38e890a` (lockfile compatible con la imagen Node 20).

- La imagen Docker se construyo correctamente con `npm ci`, `prisma generate` y
  `npm run build`.
- Se aplicaron correctamente las migraciones
  `20260916170000_conversation_guard_support` y
  `20260917123000_advertising_attribution` sobre `hermes_db`.
- El contenedor `hermes-app` quedo estable y el registro confirma que
  `AdvertisingModule` y las rutas `/api/advertising/*` estan cargados.
- La comprobacion local de `/api/advertising/status` devolvio `401 Unauthorized`
  sin JWT, que confirma que la ruta esta disponible y protegida.
- Los flags de envio y metricas de Google permanecen desactivados. No se envio
  ningun evento real ni se modificaron pujas o conversiones de Google Ads.

Antes de activar datos reales, restringir PostgreSQL (`5432`) y Redis (`6379`) al
host o a la red interna de Docker, salvo que un firewall ya limite expresamente
el acceso externo. Ambos puertos aparecian publicados por Docker durante la
verificacion.

La VPS no necesita instalar Google Cloud CLI ni Codex. Las operaciones de Cloud
(crear identidad, habilitar APIs y conceder IAM) se realizan desde una estacion
administrativa con `gcloud` o Google Cloud Console. La VPS solo necesita que el
contenedor `app` encuentre ADC. En una infraestructura fuera de Google Cloud se
prefiere Workload Identity Federation. Si aun no existe un proveedor OIDC para
ello, una prueba controlada puede montar una llave JSON de cuenta de servicio
como secreto de solo lectura, fuera del repositorio, con permisos `0600`; debe
rotarse o eliminarse al sustituirla por federacion.

## Auditoria del backend

Hermes ya contaba con NestJS, Prisma/PostgreSQL, Redis/BullMQ, autenticacion JWT,
validacion global estricta, CORS configurable, verificacion HMAC del webhook de
Meta e idempotencia de mensajes mediante `Message.wamid`. Tambien existian
`CampaignSource` y `AdsMetadata`, pero representan una fuente asociada
directamente a un lead y metadatos publicitarios genericos/Meta. No conservaban
referencias temporales, multi-touch, consentimiento por visita, diagnosticos de
Google ni hitos comerciales deduplicados. Por eso se conservaron sin cambiar y
se creo el dominio independiente `advertising`.

El pipeline actual crea un solo lead por conversacion/contacto y evita oportunidades
abiertas duplicadas con advisory locks. La IA solo puede producir el hito
`LEAD_QUALIFIED` despues de que las reglas existentes cambian realmente la etapa.
Los contratos ganados requieren una operacion autenticada del CRM con importe,
moneda y referencia comercial.

## Contrato para UnderCodeEC

UnderCodeEC debe capturar en su propio repositorio `gclid`, `gbraid`, `wbraid` y
los UTM sin modificarlos, aplicar su CMP/Consent Mode v2 y llamar desde su backend
(nunca desde el navegador con el secreto) a:

`POST /api/advertising/contact-intents`

Cabecera obligatoria:

`X-Hermes-Attribution-Key: <AD_ATTRIBUTION_INTEGRATION_KEY>`

Payload:

```json
{
  "gclid": "valor-exacto-opcional",
  "gbraid": "valor-exacto-opcional",
  "wbraid": "valor-exacto-opcional",
  "utmSource": "google",
  "utmMedium": "cpc",
  "utmCampaign": "es-b2b",
  "utmContent": "anuncio-a",
  "utmTerm": "software a medida",
  "landingPage": "https://undercodeec.com/servicios",
  "visitedAt": "2026-09-17T12:00:00.000Z",
  "consent": {
    "adStorage": "GRANTED",
    "analyticsStorage": "GRANTED",
    "adUserData": "GRANTED",
    "adPersonalization": "DENIED",
    "source": "CMP",
    "recordedAt": "2026-09-17T12:00:00.000Z"
  }
}
```

Los estados validos de consentimiento son `UNSPECIFIED`, `GRANTED` y `DENIED`.
La respuesta contiene `reference`, `expiresAt` y `messageSuffix`. La web debe
anexar literalmente el sufijo al mensaje de WhatsApp, por ejemplo:

`Hola, quiero solicitar informacion sobre un proyecto. Referencia: UC-...`

La referencia publica 110 bits aleatorios, no contiene identificadores publicitarios
ni datos personales y Hermes guarda solamente su HMAC. Caduca por defecto en siete
dias y admite un solo uso. Un clic registra `WHATSAPP_CLICK` no verificado, pero no
crea contacto, conversacion, lead ni atribucion confirmada. La confirmacion solo
ocurre si Meta entrega un mensaje real que contiene exactamente la referencia.

Si Hermes responde con error, timeout o limite de tasa, UnderCodeEC debe abrir
WhatsApp con el mensaje base sin referencia. No debe reintentar en el navegador ni
mostrar un error que impida el contacto.

## Reglas de atribucion

- Cada referencia confirmada se conserva como touch historico.
- El primer touch confirmado de una oportunidad es el que se usa para exportar
  sus hitos; los retornos posteriores quedan en el historial y no sobrescriben el
  origen anterior.
- Una nueva oportunidad creada explicitamente puede adquirir su propio primer
  touch. Hermes nunca crea una oportunidad adicional por cada mensaje.
- Referencias ausentes, manipuladas, caducadas o usadas no se vinculan.
- `inboundMessageId`, `(touchId, contactId)`, `(leadId, eventType)` e
  `idempotencyKey` impiden duplicados.
- Las correcciones de un hito actualizan el mismo registro y dejan auditoria; no
  crean otra conversion del mismo tipo para el lead.

## API protegida para el panel CRM

Todas estas rutas requieren JWT; los cambios de integracion, mapeos, revocaciones
y sincronizacion manual requieren rol `ADMIN`.

- `GET /api/advertising/dashboard?from=<ISO>&to=<ISO>`
- `GET /api/advertising/status`
- `PUT /api/advertising/integration`
- `GET|PUT /api/advertising/mappings`
- `POST /api/advertising/leads/:id/events`
- `GET /api/advertising/leads/:id/history`
- `POST /api/advertising/contacts/:id/revoke`
- `GET /api/advertising/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /api/advertising/metrics/sync`

El dashboard devuelve `null`, no cero, cuando el gasto o un indicador calculado
no esta disponible. `estimatedMargin` permanece `null` porque Hermes aun no tiene
costes suficientes para calcularlo de forma verificable.

## Google Data Manager API

La exportacion usa `POST https://datamanager.googleapis.com/v1/events:ingest`, no
el metodo heredado `UploadClickConversion`. El `idempotencyKey` estable se envia
como `transactionId`; `gclid`, `gbraid` y `wbraid` se envian solo si existen. Los
datos de usuario se normalizan y hashean solo si `adUserData=GRANTED` y
`ADVERTISING_GOOGLE_INCLUDE_USER_DATA=true`. La respuesta HTTP se conserva como
`SUBMITTED`; solo el diagnostico posterior de `requestStatus:retrieve` puede
marcar `ACCEPTED`, `PARTIAL` o `FAILED`. `VALIDATED` significa que Google valido
una solicitud `validateOnly`; no significa conversion aceptada ni atribuida.

Los envios reales requieren simultaneamente:

1. integracion y mapeo habilitados en la base de datos;
2. `ADVERTISING_GOOGLE_SYNC_ENABLED=true`;
3. `ADVERTISING_GOOGLE_SEND_ENABLED=true` (si es `false`, usa `validateOnly`);
4. ADC con scope `https://www.googleapis.com/auth/datamanager`;
5. acceso de la identidad ADC a la cuenta y accion de conversion.

Para conversiones offline, la accion de Google Ads debe ser compatible con
`UPLOAD_CLICKS`. No se cambian pujas, presupuestos ni la condicion primaria o
secundaria en Google Ads. La recomendacion inicial es exportar
`LEAD_QUALIFIED`; reuniones y contratos deben mantenerse como resultados
diferenciados y habilitarse solo tras revisar la doble contabilizacion.

Documentacion oficial consultada:

- https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest
- https://developers.google.com/data-manager/api/devguides/events/send-events
- https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve
- https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access

## Informes de Google Ads

La lectura usa `googleAds:searchStream`, `metrics.cost_micros` y cache diario en
PostgreSQL. La moneda y zona horaria proceden de la cuenta. La UI nunca recibe
credenciales. Se necesita API de Google Ads habilitada, OAuth/ADC con scope
`adwords` y acceso al customer (y manager si aplica). Desde el retiro de
Developer Tokens el 2026-09-09 no se configura ni se envia
`GOOGLE_ADS_DEVELOPER_TOKEN`; el proyecto de las credenciales OAuth/ADC determina
el acceso. La version es configurable mediante `GOOGLE_ADS_API_VERSION`.

### Pasos pendientes para completar la activacion

El paso de metricas de la guia anterior queda completado como prueba de acceso,
pero su instruccion de obtener un Developer Token queda reemplazada por la
politica anterior. Mantener todos los interruptores Google en `false` hasta el
paso 4.

1. **ADC en la VPS con la identidad existente.** No crear otra cuenta de servicio
   ni volver a conceder acceso Ads. El operador confirmó el 2026-09-17 que la
   identidad existente tiene `Service Usage Consumer`. **COMPLETADO (confirmado
   por el operador, 2026-09-17):** ADC fue montado como secreto de solo lectura
   en `hermes-app`; una consulta GAQL de solo lectura devolvió `HTTP 200` y una
   fila desde producción. No se enviaron conversiones.
2. **Accion de conversion.** **COMPLETADO (confirmado por el operador,
   2026-09-17):** la acción identificada es compatible con `UPLOAD_CLICKS` y se
   mantiene secundaria durante la prueba. La consulta GAQL de producción
   confirmó la acción `7774640817` (`Hermes - Lead cualificado`).
3. **Configurar Hermes de forma cerrada.** La migracion ya esta aplicada en la
   VPS. Guardar solo `GOOGLE_CLOUD_PROJECT`, `GOOGLE_ADS_CUSTOMER_ID`,
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_CURRENCY` y
   `GOOGLE_ADS_TIME_ZONE` en el entorno seguro. No usar
   `GOOGLE_ADS_DEVELOPER_TOKEN`. Mantener `ADVERTISING_GOOGLE_SYNC_ENABLED`,
   `ADVERTISING_GOOGLE_SEND_ENABLED`, `ADVERTISING_GOOGLE_METRICS_ENABLED` y
   `ADVERTISING_GOOGLE_INCLUDE_USER_DATA` en `false`.
   **COMPLETADO (confirmado por el operador, 2026-09-17):** se creó la
   integración `GOOGLE_ADS` y el mapeo secundario `LEAD_QUALIFIED` hacia la
   acción `7774640817`; `conversionSyncEnabled`, métricas y todos los flags de
   entorno de Google continúan desactivados.
4. **Integracion y prueba validateOnly.** El preflight del 2026-09-17 confirmó
   que no existe aún un lead marcado como control/test que cumpla
   simultáneamente atribución `CONFIRMED`, `ad_user_data=GRANTED` e identificador
   `gclid`, `gbraid` o `wbraid`. La intervención humana pendiente es generar un
   clic real y autorizado, otorgar consentimiento y enviar por WhatsApp el
   mensaje con la referencia `UC-...` emitida por Hermes. Tras confirmar el
   touch, autorizar explícitamente el `LEAD_ID` de control y proporcionar un JWT
   `ADMIN` por un canal seguro. Solo entonces activar temporalmente
   `conversionSyncEnabled=true` y `ADVERTISING_GOOGLE_SYNC_ENABLED=true`, con
   `ADVERTISING_GOOGLE_SEND_ENABLED=false`, registrar una sola vez
   `LEAD_QUALIFIED` y verificar `VALIDATED`. Revertir ambos interruptores al
   terminar.
5. **Envio real controlado.** Activar `ADVERTISING_GOOGLE_SEND_ENABLED=true`,
   crear un nuevo lead de prueba y revisar el diagnostico posterior
   (`ACCEPTED`, `PARTIAL` o `FAILED`). `SUBMITTED` no prueba atribucion.
6. **Metricas.** Una vez validada la conversion, activar
   `metricsSyncEnabled=true` y `ADVERTISING_GOOGLE_METRICS_ENABLED=true`; correr
   una sincronizacion de rango corto y comprobar las metricas diarias guardadas.

## Privacidad y retencion

Las tablas publicitarias no guardan conversaciones completas. Los identificadores
publicitarios quedan restringidos a endpoints JWT. La revocacion marca las
atribuciones como `REVOKED`, deniega usos publicitarios posteriores y cancela
trabajos pendientes. Como politica inicial propuesta, ejecutar una tarea operativa
que elimine referencias no confirmadas a los 30 dias, identificadores de clic a
los 90 dias salvo obligacion justificada y metricas agregadas segun la politica
contable. Esos plazos y las bases juridicas requieren revision legal para Espana;
esta implementacion no constituye certificacion RGPD.

## Migracion, despliegue y rollback

1. Realizar backup de PostgreSQL.
2. Aplicar `npx prisma migrate deploy`.
3. Configurar secretos mediante el gestor de secretos, no en Git.
4. Mantener todos los flags Google en `false` y probar referencia/webhook.
5. Configurar ADC y ejecutar primero Data Manager con `validateOnly`.
6. Habilitar metricas y finalmente un unico mapeo controlado.

La migracion es aditiva. Para rollback de aplicacion se puede desplegar la version
anterior conservando las tablas nuevas. Eliminarlas implica perdida de historial y
solo debe hacerse, despues de backup, con un script aprobado expresamente; no se
incluye un `DROP` automatico.
