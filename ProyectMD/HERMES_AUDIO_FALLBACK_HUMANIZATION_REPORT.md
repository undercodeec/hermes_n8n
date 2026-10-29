# HERMES — Informe de humanización del fallback de audio

Fecha: 2026-10-29. Alcance: desarrollo local y publicación Git; sin acceso ni despliegue VPS.

## Hallazgo y flujo actual

El texto técnico anterior se generaba en `hermes-backend/src/auto-replies/auto-reply.service.ts`, en el `catch` de transcripción de `AutoReplyService.process`. Allí había cuatro variantes visibles para el cliente: proveedor no disponible, audio largo, transcripción poco clara y error genérico. La causa del incidente observado en producción **no se pudo determinar**: no se consultaron logs ni credenciales productivas. El código permite distinguir las causas en adelante, sin afirmar que se agotaron créditos.

1. `WebhookService` recibe y valida el evento de WhatsApp, deduplica por `wamid`, actualiza contacto y conversación, guarda el mensaje `AUDIO` con `rawPayload.audio.id` y lo incorpora al turno entrante.
2. `AutoReplyService.process` reclama el turno y localiza los mensajes `AUDIO` pendientes (`[Audio]`).
3. `VoiceService.transcribe` comprueba configuración y clave del proveedor antes de solicitar el archivo a `MetaService.downloadInboundAudio`. Meta obtiene metadatos y descarga desde `lookaside.fbsbx.com` con token del servidor, límite de tamaño y tiempo.
4. `VoiceService` calcula duración con `ffprobe` y envía el archivo al STT. El proveedor predeterminado es **ElevenLabs** (`HERMES_STT_PROVIDER=elevenlabs`, endpoint `/v1/speech-to-text`, modelo `scribe_v2`, autenticación `xi-api-key` mediante `ELEVENLABS_API_KEY`). OpenAI es una alternativa configurable (`/v1/audio/transcriptions`, modelo predeterminado `gpt-4o-mini-transcribe`, `OPENAI_API_KEY`). ElevenLabs participa realmente en la transcripción entrante; también se usa en la síntesis de salida.
5. Si la transcripción es válida, se guarda en el mensaje entrante y `processTurn` entrega el texto al motor seleccionado, incluido Nous. Si falla, se prepara un `SYSTEM_NOTICE` por el ledger de entregas y se completa el turno.

No hay una consulta local de saldo/cuota antes del STT. Una cuota insuficiente solo se clasifica cuando el proveedor devuelve evidencia explícita (HTTP 402 o códigos `insufficient_quota`, `quota_exceeded`, `insufficient_credits`). HTTP 429 se clasifica como límite de tasa; HTTP 401/403 sin código explícito de cuota se clasifica como autenticación. No se realizó tráfico real a Meta, ElevenLabs ni OpenAI.

## Respuesta implementada

Con nombre seguro:

> Hola, Carlos. 😊
>
> Recibí su nota de voz, pero esta vez no pude escucharla correctamente.
>
> ¿Podría escribirme por aquí lo que necesita? Con gusto le ayudo.

Sin nombre seguro, el saludo es `Hola. 😊`. El nombre se lee del contacto relacionado con la conversación; se usa el primer nombre tras normalización y se rechazan cadenas vacías, números, identificadores telefónicos, marcadores genéricos y caracteres que no correspondan a un nombre. No se infiere género. Si falla la consulta del nombre, la plantilla se entrega sin personalizar.

La plantilla es determinista y única para todos los fallos de procesamiento de audio entrante. El cliente no recibe datos del proveedor, credenciales ni excepciones. Los textos antiguos ya no se generan en esa ruta.

## Diagnóstico interno

El evento `audio_transcription_failed` conserva `reasonCode`, categoría, proveedor, modelo, MIME, tamaño, HTTP, código estructurado del proveedor, código de transporte, identificador de petición, tipo de fallo, `inboundMessageId` y `conversationId`. Añade `operationStatus=FAILED`, `durationMs`, `occurredAt` y `recoverable`. Se omiten del log los mensajes libres del proveedor y transporte, que pueden contener información sensible; los identificadores y códigos se restringen a caracteres seguros. No se registra el contenido del audio ni de la transcripción en este evento.

| Categoría | Evidencia usada |
| --- | --- |
| `META_DOWNLOAD` | Error de obtención de Meta sin evidencia más específica |
| `FILE_UNAVAILABLE` | Media ID/archivo ausente, HTTP 404/410 |
| `UNSUPPORTED_FORMAT` | MIME no audio o código explícito `invalid_audio`/`unsupported_format` |
| `AUTHENTICATION` | Clave STT ausente o HTTP 401/403 sin evidencia de cuota |
| `QUOTA` | HTTP 402 o código explícito de cuota/créditos |
| `RATE_LIMIT` | HTTP 429 |
| `TIMEOUT` | `ETIMEDOUT` o `ECONNABORTED` |
| `STT_SERVICE` | Fallo del proveedor STT sin señal más específica |
| `EMPTY_TRANSCRIPT` | Texto STT vacío (`STT_EMPTY`) |
| `UNKNOWN` | Error sin evidencia suficiente, incluido límite de texto o baja confianza |

`recoverable` solo es verdadero para timeout, límite de tasa y HTTP 5xx de Meta/STT; expresa posibilidad técnica, **no** activa un reenvío. Una causa no demostrada permanece en una categoría general. La descarga de Meta y el STT de OpenAI ahora conservan diagnósticos estructurados; la transcripción vacía se distingue de la excesivamente larga.

## Archivos modificados

- `hermes-backend/src/auto-replies/audio-fallback.ts` y `.spec.ts`: plantilla, validación de nombre y clasificación.
- `hermes-backend/src/auto-replies/auto-reply.service.ts` y `.spec.ts`: uso de plantilla, diagnóstico y pruebas de entrega.
- `hermes-backend/src/voice/voice.service.ts` y `.spec.ts`: diagnóstico Meta/OpenAI y motivo explícito de texto vacío.
- `hermes-backend/src/meta/meta.service.ts` y `.spec.ts`: motivos tipados para metadatos/archivo no disponibles y formato inválido.

No se modificaron motor, prompts, reglas comerciales, handoff, STOP, F3/F4, aprendizaje, esquema de base de datos ni ledger. El flujo de éxito mantiene la transcripción en el historial y la pasa a Nous. El fallback conserva `sourceMessageId=turn.lastMessageId`, `SYSTEM_NOTICE` y la reclamación del turno. Un evento repetido no prepara ni envía una segunda disculpa; el tratamiento de entregas de estado incierto permanece a cargo del ledger existente.

## Verificación local

- Jest dirigido (`audio-fallback`, `auto-reply`, `voice`, `meta`): **4 suites, 231 pruebas aprobadas**. Incluye éxito con `gemini_direct` y `nous_hermes`, fallo Meta, proveedor, cuota y timeout simulados, transcripción vacía, nombres válidos/no válidos, reintento del turno y ausencia de doble envío. Todos los datos y llamadas son sintéticos o mockeados.
- `npm run build`: **aprobado**.
- ESLint de los ocho archivos modificados: **aprobado**.
- Prettier de los ocho archivos modificados: **aprobado**.
- ESLint global: **no aprobado**, con 60 errores y 7 avisos en archivos ajenos a este cambio; no se ampliaron correcciones fuera del alcance.
- `git diff --cached --check`: **aprobado** antes del commit.

## Git y preparación de publicación

Rama local: `feat/audio-fallback-humanization`, creada desde `bae4abee5b6836ff2512c36f00f2a6b7e4ad3b31` (cabeza de `origin/pilot/a7-d12-monitor-only-20261026` y `origin/feat/inbox-audio-playback` al iniciar). Commit de código: `d23ca971c9484a31c99f1ab8301ae18a5bd1977e`. La rama se publicará por `origin` después de incorporar este informe; el estado remoto final debe verificarse tras el push.

Esta rama es candidata de backend. Para una publicación productiva futura se requiere promover/integrar el commit en la rama de release autorizada, producir la imagen aprobada y efectuar la verificación y despliegue mediante el procedimiento independiente de Codex VPS. No se hizo ninguna de esas operaciones en este trabajo local.

Riesgos pendientes: sin registros productivos no se sabe qué falló en el caso real; Meta puede expirar archivos antiguos; el lint global previo al cambio sigue fallando; el comportamiento real de proveedor y WhatsApp requiere validación en el proceso posterior de release.
