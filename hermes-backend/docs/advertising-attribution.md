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
- Entrega 3: Data Manager API IMPLEMENTADO y PROBADO con mocks; NO VALIDADO CON
  GOOGLE y NO DESPLEGADO.
- Entrega 4: sincronizacion/cache y API de dashboard IMPLEMENTADOS; interfaz web,
  credenciales y validacion real PENDIENTES.

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

El acceso de la identidad local ya quedo demostrado. Aun falta crear o preparar
una identidad no personal para el servidor de produccion (identidad adjunta,
Workload Identity o impersonacion), concederle acceso dentro de Google Ads y
probarla separadamente.

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

1. **Identidad de produccion y permisos Ads.** Crear/configurar la identidad del
   servidor sin llave JSON permanente, darle `Service Usage Consumer` en Cloud y
   acceso a la cuenta Ads o MCC. Repetir la consulta GAQL de solo lectura con esa
   identidad.
2. **Accion de conversion.** Verificar en Google Ads que la accion identificada
   sea compatible con `UPLOAD_CLICKS` y mantenerla secundaria durante la prueba.
3. **Configurar Hermes de forma cerrada.** Aplicar la migracion y guardar solo
   `GOOGLE_CLOUD_PROJECT`, `GOOGLE_ADS_CUSTOMER_ID`,
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_CURRENCY` y
   `GOOGLE_ADS_TIME_ZONE` en el entorno seguro. No usar
   `GOOGLE_ADS_DEVELOPER_TOKEN`. Mantener `ADVERTISING_GOOGLE_SYNC_ENABLED`,
   `ADVERTISING_GOOGLE_SEND_ENABLED`, `ADVERTISING_GOOGLE_METRICS_ENABLED` y
   `ADVERTISING_GOOGLE_INCLUDE_USER_DATA` en `false`.
4. **Integracion y prueba validateOnly.** Como administrador, crear la
   integracion y el mapeo inicial `LEAD_QUALIFIED`; activar solo
   `ADVERTISING_GOOGLE_SYNC_ENABLED=true` y generar un lead de control con
   GCLID/GBRAID/WBRAID y `adUserData=GRANTED`. Verificar `VALIDATED` en el
   historial y estado de Hermes.
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
