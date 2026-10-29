# HERMES AUDIO INBOX — entrega de release para Codex VPS

**Fecha de preparación:** 29/10/2026, 11:12 (America/Guayaquil)

**Dictamen local:** `READY_FOR_VPS_DEPLOY`
**Alcance:** publicación de código y artefacto desde Codex Local Windows. **No se ha ejecutado ningún despliegue ni verificación en la VPS durante esta operación.** Codex VPS debe completar su preflight y puede bloquear el despliegue si el estado servido difiere de las bases previstas.

Este documento reemplaza, para la preparación local del release, el bloqueo SSH registrado en `HERMES_AUDIO_INBOX_DEPLOY_REPORT_2026-10-29.md`. El bloqueo era de una tarea anterior que incluía operaciones VPS; el alcance actual las asigna exclusivamente a Codex VPS.

## 1. Identidades aprobadas y publicadas

| Componente | Referencia publicada | Commit completo | Tree SHA |
|---|---|---|---|
| Backend | `origin/pilot/a7-d12-monitor-only-20261026` y `origin/feat/inbox-audio-playback` | `bae4abee5b6836ff2512c36f00f2a6b7e4ad3b31` | `dff2dda456b9a70f9e3c3ac531bce94bf0c0a9d7` |
| Frontend | `origin/main` y `origin/feat/inbox-audio-playback` | `22bb11dc5231c6d1098f023e0213e75917ec4242` | `b5f6e5dce0fa57d205a85f0a62b4ac49b303a373` |

El backend avanzó por fast-forward desde `e673417b9f2fa959959c5e0a75fad1d08d006388` en la rama piloto que exige el workflow GHCR. El frontend avanzó por fast-forward de un solo commit desde `ba36fd6abf516a4c9c0c1963a8203ea92161247a` en `origin/main`. No hubo force push ni cambios en los worktrees ajenos. El `main` backend continúa en `50c3d0f005683ef294d29cb6fab86fb4a8e134e1` y diverge de la línea A7-D21 utilizada para el backend productivo anterior; **no construir este release desde `main` backend**.

## 2. Imagen backend publicada

- **Referencia inmutable para Compose:** `ghcr.io/undercodeec/hermes-backend@sha256:dd124837e8956918aad20c93a5baff31798f5d2496256ffbe651547e8e8ff6df`
- **Etiqueta de trazabilidad:** `ghcr.io/undercodeec/hermes-backend:bae4abee5b6836ff2512c36f00f2a6b7e4ad3b31-run40908597097-attempt1`
- **GitHub Actions:** [run 40908597097, `success`](https://github.com/undercodeec/hermes_n8n/actions/runs/40908597097), workflow manual `hermes-backend-ghcr-manual.yml` ejecutado desde `main` con `source_sha=bae4abee5b6836ff2512c36f00f2a6b7e4ad3b31` y `expected_tree=dff2dda456b9a70f9e3c3ac531bce94bf0c0a9d7`.
- El workflow comprobó que el source SHA era el HEAD remoto de la rama piloto, hizo checkout exacto, verificó el árbol, construyó y publicó fuera de la VPS, inspeccionó el índice OCI `sha256:dd124...6df`, confirmó manifiesto `linux/amd64`, descargó la etiqueta y verificó `org.opencontainers.image.revision=bae4abee5b6836ff2512c36f00f2a6b7e4ad3b31`. El manifiesto `unknown/unknown` del índice es la atestación de build, no una arquitectura de ejecución adicional.
- El acceso a GHCR **desde la VPS** no fue probado por Codex Local; Codex VPS debe comprobar el pull/autorización antes de alterar Compose.

## 3. Contrato y compatibilidad

El backend extiende el endpoint existente `GET /api/conversations/:id/messages/:messageId/media`. Conserva JWT y roles `ADMIN`/`SALES_AGENT`. Busca el mensaje dentro de la conversación; permite audio entrante `CONTACT` mediante `rawPayload.audio.id` y audio saliente `HERMES` mediante `metadata.voiceMediaId`. Continúa usando la ruta previa para imágenes y PDF. Si falta el Media ID, responde como adjunto no encontrado.

La descarga se realiza bajo demanda mediante Meta; el token y la URL privada no llegan al navegador. El descargador existente exige MIME `audio/*`, límite de 16 MiB, HTTPS en `lookaside.fbsbx.com` y sin redirecciones. La respuesta utiliza `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` y el MIME devuelto por Meta. Los medios antiguos pueden no estar disponibles; la transcripción permanece en Inbox y se presenta un error de carga. El reproductor nativo tiene enlace de descarga si el navegador no decodifica el formato.

El frontend usa el método autenticado existente `hermesApi.inboxMedia`, crea una Blob URL local y la revoca al desmontar o cambiar. Muestra reproducción para audio de cliente y asistente, sin alterar el texto transcrito, imágenes/PDF, Leads ni el panel de atribución. **Desplegar backend compatible antes de cambiar el frontend** para evitar botones de audio que llamen a un backend anterior.

Los cambios no añaden dependencias, migraciones, cambios de esquema ni variables de entorno. No modifican el motor Nous, su transcripción, asignación de motores, F3/F4, colas ni los flujos de envío WhatsApp.

## 4. Archivos y pruebas

**Backend:** `hermes-backend/src/conversations/conversations.controller.ts`, `conversations.service.ts`, `conversations.service.spec.ts`.
**Frontend:** `src/app/admin/crm/inbox/page.jsx`, `src/app/admin/crm/crm.css`, `src/lib/hermes/inbox-media.mjs`, `tests/hermes-inbox-media.test.mjs`.

| Verificación | Resultado |
|---|---|
| Backend, suite completa en commit candidato | 97 suites, 1547 pruebas aprobadas |
| Backend build y ESLint de archivos cambiados | Aprobados |
| Frontend, suite completa sobre `main` integrado | 174 aprobadas, 1 omitida, 0 fallidas |
| Frontend build y ESLint sobre `main` integrado | Aprobados; aviso no bloqueante de Browserslist desactualizado |
| Diferencias Git y secretos | Solo los 3 archivos backend y 4 frontend enumerados; sin paquetes/migraciones nuevos ni líneas añadidas con secretos evidentes; `git diff --check` limpio |

Las pruebas backend cubren audios de ambos emisores, ausencia de Media ID, ruta existente de imagen y rechazo de remitentes no admitidos. La suite previa de webhook/transcripción también pasó. La reproducción con audios reales, la sesión CRM y el comportamiento del navegador **no** fueron probados desde Windows; corresponden al postflight de Codex VPS con acceso autorizado.

## 5. Preflight y despliegue a cargo de Codex VPS

1. Leer `/root/evidence/hermes-release-state/current.json` y contrastarlo con Compose, imagen efectiva, enlace web activo, PM2 y los SHAs servidos. Los commits `e673417`/`ba36fd6` del informe anterior son **referencias históricas**, no sustituyen esta lectura. Si el backend servido difiere de la base `e673417` o el web servido difiere de `ba36fd6`, revisar el delta y compatibilidad antes de continuar.
2. Revisar salud y recursos de Docker/PM2, PostgreSQL, Redis, colas, trabajos pendientes o ambiguos, flags Nous y locks de despliegue. Verificar ausencia de intervención concurrente y disponibilidad del rollback inmediato real.
3. Comprobar que GHCR permite descargar el digest inmutable. Usar el flujo Compose validado del servidor para cambiar **solo** `app` por ese digest, sin build en VPS, sin migración y sin reiniciar otros servicios. Validar el render Compose y conservar la configuración Nous vigente. Verificar backend saludable y el endpoint protegido antes del frontend.
4. Inspeccionar el contrato y parámetros de `/usr/local/sbin/deploy-web-undercodeec`. Publicar el frontend desde `origin/main` **exactamente** `22bb11dc5231c6d1098f023e0213e75917ec4242` mediante ese script, no mediante `git pull` simple ni build manual fuera de su procedimiento. Recargar solo `web-undercodeec` según el script.
5. Comprobar CRM, Inbox, Leads, panel de atribución, assets, autenticación/roles del endpoint, reproducción de un audio entrante y uno saliente disponibles en Meta con sesión autorizada, errores/expiración y presencia de la transcripción. No generar mensajes WhatsApp nuevos innecesarios. Revisar PM2, Docker, PostgreSQL, Redis, colas y flags Nous tras el cambio. No dar por validada reproducción por HTTP 200 sin prueba funcional.
6. Registrar SHAs, digest, BUILD_ID, identidades anteriores/nuevas, salud, resultados reales y actualizar `current.json` solo tras postflight exitoso. Si algún preflight falla, no desplegar y emitir bloqueo.

## 6. Riesgos y rollback

- Meta puede dejar de ofrecer medios antiguos; esta función no almacena bytes permanentemente. La transcripción sigue accesible.
- La disponibilidad de audio en Safari u otros navegadores depende del códec entregado por Meta; se ofrece descarga, pero la prueba real de navegador está pendiente.
- La visibilidad/acceso del paquete GHCR desde VPS y la identidad productiva actual requieren verificación del agente VPS.
- Para una regresión del frontend, restaurar únicamente la release web activa **inmediatamente anterior**, tras leer su identidad efectiva, usando el lock/procedimiento PM2 vigente. Para una regresión backend, restaurar únicamente el digest `app` efectivo anterior mediante el Compose validado. No presumir que los rollbacks históricos A7-D27 siguen siendo los inmediatos. No revertir datos ni borrar colas; no cambiar Nous ni reenviar mensajes ambiguos.

**Límite del dictamen:** `READY_FOR_VPS_DEPLOY` certifica que los dos artefactos de Git/GHCR están publicados y son compatibles según el código y las pruebas locales. No certifica despliegue, salud ni reproducción en producción.
