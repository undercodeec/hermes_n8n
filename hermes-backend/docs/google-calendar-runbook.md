# Google Calendar / Meet en Hermes

## Estado y arquitectura

Integración local con feature flag. No despliega ni autoriza cuentas automáticamente.
GoogleCalendarService usa googleapis/OAuth2 oficiales y Calendar v3. MeetingsService
gestiona estado estructurado en ConversationState; MeetingOperationsService conserva
operaciones durables, revalida y actualiza Meeting, Task APPOINTMENT y auditoría.
AutoReply prioriza handoff humano explícito y reutiliza AutomatedDelivery para enviar
las respuestas. Calendar es la fuente de disponibilidad; el LLM no calcula slots.

## Variables

| Variable | Valor inicial |
| --- | --- |
| GOOGLE_CALENDAR_ENABLED | false |
| GOOGLE_CLIENT_ID | vacío; configuración privada |
| GOOGLE_CLIENT_SECRET | vacío; configuración privada |
| GOOGLE_REFRESH_TOKEN | vacío; configuración privada |
| GOOGLE_CALENDAR_ID | primary |
| GOOGLE_CALENDAR_TIMEZONE | America/Guayaquil |
| GOOGLE_OAUTH_REDIRECT_URI | http://localhost:3003/api/integrations/google/callback |
| GOOGLE_MEETING_DURATION_MINUTES | 30 |
| GOOGLE_MEETING_BUFFER_MINUTES | 15 |
| GOOGLE_MEETING_BUSINESS_START | 09:00 |
| GOOGLE_MEETING_BUSINESS_END | 18:00 |
| GOOGLE_MEETING_BUSINESS_DAYS | 1,2,3,4,5 (lunes=1, domingo=7) |

Deshabilitado arranca sin secretos; habilitado requiere las tres credenciales.
El horario debe ser válido y ordenado; duration>0, buffer>=0, días únicos y timezone
IANA válido. `primary` corresponde a la cuenta OAuth autorizada; un calendario
compartido requiere permiso de escritura y compatibilidad con conferencias Meet.
El grid de propuestas es de quince minutos, sujeto a duración y horario comercial.
Buffer se aplica antes y después de ocupaciones remotas y reservas locales;
la consulta remota también incluye los márgenes para detectar reuniones adyacentes.
Las reuniones nuevas usan una política regional autoritativa: Ecuador continental
(`America/Guayaquil`) de 08:00 a 20:00; España peninsular/Baleares (`Europe/Madrid`)
y Canarias (`Atlantic/Canary`) de 14:00 a 20:00 locales. La reunión debe terminar
antes o a las 20:00; con 30 minutos, el último inicio es 19:30. La duración, el
buffer y los días laborables continúan configurándose por las variables anteriores.
BUSINESS_START/END y CALENDAR_TIMEZONE son la política de respaldo para reuniones
antiguas de otras zonas y la zona de consulta del calendario, no la zona del cliente.
La disponibilidad de un mismo calendario se compara por instantes UTC para evitar
conflictos entre citas ecuatorianas y españolas. IANA resuelve el cambio estacional
de España; no se fija una diferencia horaria constante con Ecuador.

## Bootstrap LOCAL (fase controlada posterior)

1. Confirmar Calendar API habilitada, OAuth Web Application y cuenta en Test Users.
2. Verificar en Google Cloud el registro exacto de localhost:3003. El JSON entregado
   originalmente enumera solo el callback productivo y puede ser anterior al cambio.
   Editar un JSON local no registra una URI en Google.
3. Desde hermes-backend ejecutar explícitamente:

```powershell
npm run google:calendar:authorize -- --credentials "D:\ruta\client_secret_oauth.apps.googleusercontent.com.json" --output "D:\Documentos\Hermes\hermes-backend\secrets\google-calendar.env"
```

La CLI escucha únicamente en 127.0.0.1:3003. Ese puerto debe estar libre: detener
el backend si lo ocupa. Abra la URL impresa, autorice los dos scopes Calendar y
regrese al callback. El state aleatorio vence en diez minutos y solo se usa una vez.
La CLI guarda únicamente refresh token en archivo ignorado por Git, creado sin
sobrescritura, con permisos 0600 en Unix o ACL exclusiva del usuario en Windows.
No muestra secretos ni devuelve tokens en HTML. Si el archivo ya existe, use otro
nombre y reemplácelo manualmente tras comprobar la nueva autorización.

Los endpoints GET /api/integrations/google/auth y /callback solo funcionan con
NODE_ENV=development y acceso localhost directo. El endpoint confirma recepción,
pero descarta el token; use la CLI para guardarlo. En producción no están disponibles.
No aceptan redirectUri arbitrario ni modifican la cuenta vinculada del servicio.

Copie clientId/clientSecret del JSON al `.env` local privado mediante editor y
añada refresh token desde el archivo privado. El backend carga `.env`, no carga
automáticamente el archivo de bootstrap. Active el flag y reinicie solo cuando
esté lista la fase real. Los scopes son calendar.events y calendar.freebusy.

## External / Testing y producción

El modo OAuth actual es External / Testing. Con estos scopes el refresh token de
pruebas vence aproximadamente a los siete días; es aceptable durante desarrollo.
No se evita en código. invalid_grant requiere repetir autorización con consentimiento.
Antes de producción definitiva, ajustar Publishing status y cumplir los requisitos
de Google que correspondan; usar cuenta/calendario operativos y credenciales privadas.

El traslado posterior a `/etc/hermes-crm/backend.env` debe realizarlo un operador
autorizado, mediante un canal seguro, conservando permisos restrictivos. No copiar
secretos en chats, PRs, issues, logs o Git. Este proyecto no automatiza SSH ni modifica
el VPS. El callback productivo registrado no habilita el bootstrap HTTP en producción.

## Flujo e idempotencia

El cliente pide reunión/Meet/agendar cita. Si no hay una ubicación previamente
confirmada en `Contact.metadata.schedulingLocation`, se pregunta ciudad y país
antes de consultar Calendar. Ciudades conocidas o una localidad con país y, para
España no reconocida, península/Baleares o Canarias explícitos resuelven la zona;
una respuesta ambigua, España sin ciudad o una región no
soportada requiere aclaración y nunca se infiere por el teléfono. La metadata
existente del contacto se conserva al guardar ciudad, país y zona. Una ubicación
explícita nueva tiene prioridad sobre el dato recordado. Una corrección de ciudad
durante una reserva nueva invalida la selección previa y vuelve a ofrecer opciones.

Si todavía no hay fecha, se pregunta el día. Una fecha relativa proporcionada antes
de responder la ciudad conserva como referencia el momento del mensaje original.
Se generan todos los inicios libres del rango en intervalos de 15 minutos, sin
el límite de tres ni la separación artificial de dos horas. Se muestran 12 por
página con numeración continua; «ver más horarios» y «horarios anteriores» recorren
la lista. Se acepta el número o una hora libre (también `19:30`) del día propuesto,
incluso si todavía no apareció en la página. Se puede pedir otro día.

La zona se conserva en `ConversationState.meetingState` y se copia a `Meeting.timezone`
al reservar; las propuestas antiguas sin zona deben preguntar ubicación otra vez.
La reprogramación conserva la zona de la reunión existente. Tanto la validación
como el evento utilizan esa zona, no una conversión global. Los eventos llevan
`[EC]`/`[ES]` en el título y `hermesTimezone`/`hermesRegion` en propiedades privadas.
La descripción, confirmación y avisos de recuperación incluyen hora España y hora
Ecuador cuando la cita es española; al reprogramar se recalculan ambas horas
conservando el título personalizado, notas manuales y propiedades privadas ajenas.
No se requiere una migración de base de datos: se reutilizan metadata, meetingState
y timezone existentes.

Selección inequívoca y email válido preceden la reserva. FreeBusy se consulta otra vez con
buffer antes de insert. Un slot ocupado produce nuevas propuestas. La invitación
usa sendUpdates=all y conferenceDataVersion=1 con hangoutsMeet. Conferencia pendiente
se consulta hasta tres veces por intento; no se inserta otro evento para obtener Meet.

Meeting y MeetingOperation tienen claves únicas. El ID Google es un hash estable
compatible con Google; un timeout/409 se reconcilia consultando ese mismo ID y la
referencia CRM privada. Los workers tienen claims con vencimiento y fencing. Las
reservas locales se coordinan con locks por calendario; una operación de reprogramación
reserva también su destino mientras mantiene el evento anterior.

La recuperación periódica reconcilia operaciones pendientes, sin confirmar reuniones
falsas. Si el enlace tarda, el cliente recibe estado de verificación. La recuperación
prepara una confirmación durable e idempotente en AutomatedDelivery junto con el
commit CRM; respeta handoff y ventana WhatsApp antes de enviar. Al confirmar se
persiste Task, Meeting y auditoría. Un rechazo interrumpe nuevos intentos, pero no
afirma que un evento remoto ambiguo esté cancelado. La transferencia humana impide
nuevas mutaciones; un evento ya aplicado se reconcilia conservando su referencia.
Reprogramar actualiza el mismo evento/Task; cancelar requiere confirmación contextual.
La promoción NEW/CONTACTED→QUALIFIED ocurre por reunión realmente confirmada; otras
etapas se conservan y la cancelación no degrada el pipeline.

Calendar no ofrece reserva atómica entre FreeBusy e insert. Hermes coordina sus
workers y revalida inmediatamente antes de escribir, pero un actor externo puede
crear un evento dentro de esa ventana. Evitar otros sistemas reservando sin coordinación.

## Errores y recuperación

Errores estructurados: GOOGLE_CALENDAR_DISABLED, GOOGLE_CALENDAR_AUTH_FAILED,
GOOGLE_CALENDAR_REAUTH_REQUIRED, GOOGLE_CALENDAR_FREEBUSY_FAILED,
GOOGLE_CALENDAR_EVENT_CREATE_FAILED, GOOGLE_CALENDAR_EVENT_UPDATE_FAILED,
GOOGLE_CALENDAR_EVENT_DELETE_FAILED y GOOGLE_MEET_CREATION_FAILED.
MEETING_SLOT_OCCUPIED pide nuevas opciones; MEETING_OPERATION_PENDING conserva
la operación y no afirma una reserva. Los logs registran operación/código/status,
sin respuestas OAuth completas, headers, tokens ni secretos. Las URLs HTTP pierden
querystrings en logs, incluida la respuesta de error del callback.

Ante reauth, desactivar temporalmente el flag, repetir bootstrap, actualizar el
entorno privado y reiniciar. Una operación ambigua conserva reserva local para no
duplicar el evento; reconciliar el evento por ID antes de liberar esa reserva.
No borrar filas Meeting/MeetingOperation para reintentar a ciegas.

## Validación local y rollback

Pruebas automatizadas siempre usan Google simulado. Unitarias: npm test -- --runInBand.
Integración real de persistencia requiere CALENDAR_TEST_DATABASE_URL local y
CALENDAR_TEST_PSQL; crea/elimina exclusivamente esquemas temporales calendar_clean_*
y calendar_upgrade_*. La suite global de integración usa DATABASE_INTEGRATION_URL
y REDIS_INTEGRATION_URL sobre infraestructura temporal dedicada.

Ejecutar build, prisma validate, lint focalizado y security:secrets antes de commit.
La migración es aditiva; aplicar con el procedimiento de despliegue autorizado
posteriormente. Rollback funcional: GOOGLE_CALENDAR_ENABLED=false y reinicio.
Conservar tablas y auditoría; no eliminar eventos existentes automáticamente ni
ejecutar un downgrade destructivo. Las reuniones existentes deben administrarse
desde Calendar hasta reactivar la integración.

La siguiente fase requiere autorización explícita para FreeBusy real, evento tester,
verificación Meet, reprogramación, cancelación y limpieza. Despliegue productivo es
una fase separada; no fue solicitado en esta implementación.

## Calendario CRM (consulta)

El CRM consulta `GET /api/meetings?from=<ISO>&to=<ISO>` con bearer de un usuario
`ADMIN` o `SALES_AGENT`. `from`/`to` requieren un offset explícito, se normalizan
a UTC y delimitan un intervalo `[from,to)` de hasta 42 días. Se incluyen reuniones
solapadas (`startAt < to`, `endAt > from`). `status` y `timezone` son filtros
opcionales del estado y la zona almacenados; los filtros inválidos devuelven 400,
sin sesión 401 y `VIEWER` 403. No existe endpoint de edición en esta entrega.

La respuesta contiene `{ data, range }`: fechas ISO UTC y resúmenes mínimos de
contacto, lead, conversación y tarea. Lead/tarea/conversación ausentes se devuelven
como `null`. No incluye OAuth, referencias privadas del proveedor ni eventos
consultados directamente a Google. La fuente es la tabla `Meeting` existente;
no requiere una migración ni habilitar Google para leer registros persistidos.

En Next.js configurar **en el servidor** `HERMES_API_URL=http://localhost:3003/api`
(usar la URL interna del backend en despliegue). El navegador llama al proxy
`/api/hermes/meetings`; la zona de visualización no se envía como filtro, para
mantener visibles reuniones de otras regiones. La ruta es `/admin/crm/calendario/`.

Pruebas del contrato: `npm test -- meeting-read.service.spec.ts meetings.controller.spec.ts --runInBand`.
Para verificar el proxy sin datos reales, compilar Hermes y ejecutar
`node test/fixtures/crm-calendar-server.cjs`. Este fixture escucha únicamente en
127.0.0.1:3103, usa filas sintéticas en memoria y los controller/service/guards
compilados de producción. No carga `.env`, no escribe la base ni contacta Google.
Arrancar Next en el puerto 3100 con `HERMES_API_URL=http://127.0.0.1:3103/api` y
ejecutar en el frontend `CALENDAR_QA_PROXY_URL=http://localhost:3100/api/hermes`
con `node --test tests/crm-calendar-proxy.test.mjs` (en PowerShell usar `$env:`).
No arrancar este fixture en un host público ni usar su sesión para datos reales.

Verificado automáticamente: JWT/roles, filtros y rangos inválidos, solapamiento,
relaciones opcionales, estados y payload a través del proxy real de Next.
La verificación con PostgreSQL y navegador queda pendiente en este entorno:
Docker Desktop no está disponible y el control de navegador devuelve
`No browser is available`. El frontend documenta los escenarios manuales.

## Referencias de Google

- https://developers.google.com/workspace/calendar/api/guides/create-events
- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- https://developers.google.com/identity/protocols/oauth2#expiration
