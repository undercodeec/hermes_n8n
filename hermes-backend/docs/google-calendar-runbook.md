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
Buffer se aplica antes y después de ocupaciones remotas y reservas locales.

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

El cliente pide reunión/Meet; se ofrecen hasta tres opciones con timezone. Selección
inequívoca y email válido preceden la reserva. FreeBusy se consulta otra vez con
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

## Fuentes oficiales

- https://developers.google.com/workspace/calendar/api/guides/create-events
- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- https://developers.google.com/identity/protocols/oauth2#expiration
