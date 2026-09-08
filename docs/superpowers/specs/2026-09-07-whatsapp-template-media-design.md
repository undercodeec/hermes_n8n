# Diseño: multimedia reutilizable por plantilla de WhatsApp

**Fecha:** 2026-09-07

**Repositorios:** `hermes_n8n` y `websiteUndercodeec`

**Alcance:** campañas oficiales de WhatsApp Cloud API

## Objetivo

Separar la configuración técnica del multimedia de una plantilla del flujo cotidiano de creación de campañas. Una plantilla aprobada con encabezado `VIDEO` tendrá una referencia multimedia administrada una vez y reutilizada automáticamente. Cada campaña conservará un snapshot de la referencia usada para que reemplazar la configuración de la plantilla solo afecte campañas futuras.

No se almacenarán MP4 en Git ni se añadirá almacenamiento de objetos. Los Media ID cargados a Meta tienen disponibilidad temporal; Hermes detectará referencias inaccesibles antes de encolar envíos y pedirá reemplazarlas desde la configuración.

## Diagnóstico actual

Hermes ya incluye una biblioteca `CampaignMedia`, carga MP4 de hasta 16 MiB mediante `POST /api/campaigns/media`, registro y verificación de Media ID mediante `POST /api/campaigns/media/register`, y construcción correcta del componente `header -> video -> id`. La migración aplicada `20260904100000_campaign_media_library` añadió la biblioteca y la relación opcional desde `Campaign`.

La campaña ya copia `headerVideoAssetId` y `headerVideoMediaId`, por lo que existe una base de snapshot. Sin embargo, la selección del video ocurre en el navegador al crear cada campaña. No existe una relación persistente entre WABA, plantilla, idioma, tipo de encabezado y media. El backend tampoco valida hoy que una plantilla seleccionada realmente requiera video ni impide crear una campaña VIDEO sin multimedia.

En Undercodeec, `/admin/crm/campanas` carga campañas, plantillas y media mediante un único `Promise.all`; cualquier fallo elimina los tres resultados. El formulario de nueva campaña contiene la biblioteca, carga MP4, registro de Media ID y URL HTTPS. El proxy Nginx de `/api/hermes/` tiene `client_max_body_size 10m`, inferior al límite funcional de 16 MiB del frontend y de Multer, lo que explica un 413 antes de que NestJS reciba ciertos videos.

No existe un literal visible `svg` en el código actual de la página de campañas. Durante la implementación se verificará el DOM renderizado y los componentes compartidos; cualquier fallback o nodo accidental se corregirá sin convertirlo en una opción funcional.

## Alternativas consideradas

### 1. Entidad explícita de asociación, recomendada

Crear `CampaignTemplateMedia` como entidad independiente, relacionada con `CampaignMedia` y con una clave compuesta estable. Permite reemplazo sin mutar activos históricos, soporta variantes de idioma, conserva integridad referencial y deja una extensión natural para `IMAGE` o `DOCUMENT` sin implementarlas ahora.

### 2. Añadir identidad de plantilla a `CampaignMedia`

Es más pequeña, pero mezcla el activo con su uso. Dificulta reutilizar un activo en varias plantillas, conservar historial de reemplazos y representar una URL avanzada sin inventar filas de biblioteca.

### 3. Mapa JSON de plantilla a media

Reduce migraciones, pero pierde restricciones únicas, relaciones, consultas claras y auditoría consistente. Se descarta por riesgo de asociar idiomas o plantillas incorrectos.

## Persistencia

Se creará una migración Prisma nueva. No se editará `20260904100000_campaign_media_library`.

`CampaignTemplateMedia` contendrá:

- `id` UUID;
- `wabaId`;
- `metaTemplateId` opcional, porque el contrato debe seguir funcionando si Meta no lo entrega;
- `templateName`;
- `templateLanguage`;
- `headerType`, inicialmente `VIDEO` para configuración activa;
- `campaignMediaId` opcional;
- `mediaUrl` opcional para el modo avanzado;
- `createdByUserId`;
- timestamps.

La restricción única será `(wabaId, templateName, templateLanguage, headerType)`. El servicio exigirá exactamente uno entre `campaignMediaId` y `mediaUrl`. La asociación por nombre nunca se usará sin WABA, idioma y tipo de encabezado. `metaTemplateId` actuará como identificador adicional de validación y diagnóstico.

`Campaign` conservará `templateName`, `templateLanguage`, `headerVideoAssetId`, `headerVideoMediaId` y `headerVideoUrl`. Se añadirá `templateMetaId` y `templateHeaderType` como snapshot de la plantilla aprobada. La referencia histórica a `CampaignMedia` seguirá usando `onDelete: Restrict`.

Los activos anteriores no se borrarán de PostgreSQL ni de Meta durante un reemplazo. El `AuditLog` registrará la asociación anterior y la nueva, sin secretos ni archivos.

## API de Hermes

### Plantillas

`GET /api/campaigns/templates` continuará consultando plantillas aprobadas de Meta y devolverá, además de los campos actuales:

- `headerType` derivado de `components`;
- `mediaConfiguration.configured`;
- `mediaConfiguration.mediaLibraryId`;
- nombre, MIME y tamaño del activo cuando exista;
- indicador de URL avanzada sin revelar datos innecesarios;
- estado utilizable o mensaje de configuración requerida.

El WABA configurado permanecerá en el servidor. El navegador no elegirá ni enviará un Media ID al crear una campaña.

### Biblioteca existente

Se conservarán:

- `GET /api/campaigns/media`;
- `POST /api/campaigns/media`;
- `POST /api/campaigns/media/register`.

La carga seguirá validando `video/mp4` y 16 MiB tanto en Multer como en el servicio. El registro seguirá verificando el Media ID contra Meta. Estos endpoints producirán activos reutilizables, pero no decidirán por sí mismos qué campaña los usa.

### Asociación de plantilla

Se añadirá `PUT /api/campaigns/templates/media`. Recibirá la identidad de plantilla y exactamente una referencia entre `campaignMediaId` o `mediaUrl`. Antes del upsert, Hermes:

1. consultará las plantillas aprobadas de Meta;
2. comprobará `metaTemplateId`, nombre, idioma y encabezado;
3. exigirá `HEADER/VIDEO`;
4. comprobará que el activo sea `video/mp4` o que la URL HTTPS esté permitida;
5. hará upsert con la clave compuesta;
6. registrará auditoría del reemplazo.

El flujo principal de UI hará carga y asociación como dos operaciones deliberadas. Si Meta acepta el archivo pero la asociación falla, el activo queda recuperable en la biblioteca avanzada; no se borra un recurso externo como compensación insegura.

## Creación e inicio de campaña

`CreateCampaignDto` dejará de aceptar decisiones multimedia provenientes del navegador. El backend resolverá la plantilla aprobada por nombre e idioma y derivará su encabezado.

Para `VIDEO`:

1. buscará la asociación por WABA, nombre, idioma y `VIDEO`;
2. rechazará la creación con un mensaje accionable si falta;
3. copiará a `Campaign` el ID de plantilla, tipo de encabezado, activo, Media ID o URL;
4. nunca consultará nuevamente la asociación para modificar esa campaña.

Para plantillas sin encabezado multimedia o con `TEXT`, no se generará componente multimedia y el flujo actual continuará. `IMAGE` y `DOCUMENT` se reconocerán correctamente, pero no se les asignará automáticamente un video.

Al iniciar o reanudar una campaña VIDEO, Hermes validará que el snapshot exista y que la referencia siga siendo accesible. Si no lo está, no cambiará silenciosamente al video nuevo de la plantilla: bloqueará el inicio y explicará que la campaña debe recrearse o corregirse mediante un flujo explícito. Esto preserva idempotencia y reproducibilidad.

## Worker y payload

El worker seguirá cargando `Campaign` desde PostgreSQL junto con cada destinatario. Para un snapshot VIDEO con Media ID, enviará:

```json
{
  "type": "header",
  "parameters": [
    {
      "type": "video",
      "video": { "id": "<MEDIA_ID_SNAPSHOT>" }
    }
  ]
}
```

No se consultará la asociación vigente desde el worker, porque eso permitiría que un reemplazo cambiara una campaña en curso. Tampoco se modificará el claim atómico del destinatario, la semántica de `wamid`, los reintentos exclusivos de 429 ni el tratamiento conservador de timeouts y 5xx.

## UX de Undercodeec

`/admin/crm/campanas` tendrá dos áreas claras:

- **Nueva campaña:** nombre, plantilla, estado/header/configuración, CSV y creación. No mostrará controles técnicos de media.
- **Plantillas WhatsApp:** lista de plantillas aprobadas con idioma, estado, encabezado y configuración. Las plantillas VIDEO ofrecerán `Configurar video` o `Reemplazar video`.

La configuración principal permitirá subir MP4. Un bloque nativo `details/summary` de **Opciones avanzadas** contendrá selección de biblioteca, registro de Media ID existente y URL HTTPS permitida.

Al seleccionar una plantilla VIDEO configurada, el formulario mostrará un resumen positivo y no incluirá IDs sensibles. Si falta configuración, deshabilitará la creación, mostrará un mensaje y permitirá desplazarse a la configuración correspondiente. El backend mantendrá la validación autoritativa.

Las cargas de campañas, plantillas y biblioteca se ejecutarán y manejarán por separado. Cada estado tendrá su propio error; fallar `GET /campaigns/media` no vaciará plantillas ni campañas.

## Error 413 y proxies

El límite funcional se mantendrá en 16 MiB, alineado con el límite actual de Meta para video MP4. Un multipart contiene el archivo más boundaries y cabeceras; por ello los proxies que reciben la carga usarán `client_max_body_size 17m`. Esto concede hasta 1 MiB de overhead sin permitir que el archivo supere la validación de 16 MiB de Multer y del servicio.

Se actualizarán los ejemplos Nginx de Hermes y Undercodeec, no la VPS. El runbook exigirá localizar todos los `server`/`location` activos, aplicar el mismo valor en cada salto, ejecutar `nginx -t` y recargar solo después de respaldo.

En producción, el `location /api/hermes/` mostrado reenvía directamente a NestJS y evita Next.js. El Route Handler de Next continúa siendo necesario en otros entornos; para la carga multimedia reenviará el stream en lugar de materializar todo el multipart con `request.arrayBuffer()`. No se añadirá un límite arbitrario de aplicación en Next.

## Seguridad

Todos los endpoints conservarán `JwtAuthGuard` y el operador autenticado. `META_WABA_ID`, `META_PHONE_NUMBER_ID` y el token seguirán siendo configuración de servidor. El token nunca se enviará al navegador ni se persistirá en PostgreSQL. La URL avanzada seguirá una allowlist de hosts. Los Media ID se validarán en backend y no serán aceptados en el DTO normal de campaña.

## Errores y resiliencia

- Una plantilla que deja de estar aprobada no podrá recibir una nueva asociación ni crear campañas nuevas.
- Una variante de idioma nunca heredará media de otra variante.
- Un activo inexistente, incompatible o inaccesible producirá un 4xx accionable antes de la cola.
- Un fallo de Meta al listar plantillas se mostrará separado de campañas y biblioteca.
- Un fallo de biblioteca no ocultará plantillas.
- Una carga exitosa seguida de un fallo de asociación dejará un activo sin asociar y reutilizable.
- Reemplazar una asociación no tocará snapshots existentes.

## Pruebas

Hermes cubrirá:

- detección de encabezado VIDEO y otros tipos;
- asociación por WABA, plantilla, idioma y header;
- rechazo de variante de idioma incorrecta;
- creación VIDEO con y sin configuración;
- snapshot del activo y Media ID;
- reemplazo sin mutar campañas existentes;
- validación al iniciar;
- payload `header.video.id`;
- plantillas sin media header;
- idempotencia y reintentos existentes.

Undercodeec extraerá funciones de estado/carga que puedan probarse con `node:test`, sin introducir un framework nuevo. Se cubrirá que las respuestas independientes conservan plantillas cuando media falla, la detección de VIDEO, el bloqueo de creación y la construcción del payload sin campos multimedia controlados por el navegador.

La verificación final ejecutará los comandos solicitados en ambos repositorios, además de lint/pruebas focalizadas disponibles y `docker compose build app` si Docker responde. Cualquier suite omitida se reportará con su motivo exacto.

## Git y despliegue

La implementación se aislará de los cambios locales ajenos. Se crearán commits separados por repositorio y no se usarán `git reset --hard` ni `git clean`. Antes del push se verificarán ramas, diferencias con `origin/main` y resultados completos. No se modificará producción.

El despliegue posterior requerirá respaldo de PostgreSQL, `prisma migrate deploy`, build/recreación exclusiva de la app cuando corresponda, ajuste respaldado de Nginx, `nginx -t`, recarga y una prueba controlada con un único destinatario autorizado antes de ampliar el envío.
