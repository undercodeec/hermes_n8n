# HERMES AUDIO FALLBACK — handoff de release para Codex VPS

**Fecha:** 29/10/2026 (America/Guayaquil)

**Dictamen local:** `READY_FOR_VPS_DEPLOY`

**Alcance:** promoción Git e imagen GHCR desde Codex Local Windows. No hubo acceso SSH, cambios en VPS ni despliegue productivo.

## Identidad publicada

| Elemento | Valor verificado |
| --- | --- |
| Rama piloto de backend | `origin/pilot/a7-d12-monitor-only-20261026` |
| Commit fuente y HEAD remoto de la rama piloto | `1fa0e13ba46e72949797c283fab554d93d1aa1d3` |
| Tree SHA del commit fuente | `38986f32489ebf4493db32a1d3a1bf2af6aed46b` |
| Imagen inmutable | `ghcr.io/undercodeec/hermes-backend@sha256:40000b47761d2ec9784e6733154e4f3c9a19b6f0829a3c9cd1fe21e4ff6a1c89` |
| Etiqueta de trazabilidad | `ghcr.io/undercodeec/hermes-backend:1fa0e13ba46e72949797c283fab554d93d1aa1d3-run40964181232-attempt1` |
| GitHub Actions | [Run 40964181232](https://github.com/undercodeec/hermes_n8n/actions/runs/40964181232), `success` |
| Plataforma de ejecución | `linux/amd64` |

La rama piloto avanzó por fast-forward desde `bae4abee5b6836ff2512c36f00f2a6b7e4ad3b31` hasta el commit fuente. No se usó force push ni se modificó el worktree de la rama piloto. El workflow oficial `.github/workflows/hermes-backend-ghcr-manual.yml` se despachó desde `main` con `source_sha=1fa0e13ba46e72949797c283fab554d93d1aa1d3` y `expected_tree=38986f32489ebf4493db32a1d3a1bf2af6aed46b`; el workflow hizo checkout del SHA indicado, comprobó que coincidiera con el HEAD remoto de `pilot`, verificó el tree, publicó la imagen y descargó la etiqueta para confirmar `linux/amd64` y la etiqueta OCI `org.opencontainers.image.revision` con ese SHA. El `main` del workflow (`50c3d0f005683ef294d29cb6fab86fb4a8e134e1`) **no** fue el código fuente de la imagen.

La inspección independiente de GHCR con `docker buildx imagetools inspect` confirmó el digest del índice y el manifiesto `linux/amd64` (`sha256:f0aa329cd0ec7854b9cae9c110d918c99c020584383193561fa99da9b22586bf`). El segundo manifiesto `unknown/unknown` es la atestación del build, no otra plataforma de ejecución. El pull desde la VPS queda por comprobar allí.

## Compatibilidad y alcance del cambio

El commit fuente desciende directamente de `bae4abee5b6836ff2512c36f00f2a6b7e4ad3b31`, fuente de la imagen Audio Inbox publicada anteriormente como `ghcr.io/undercodeec/hermes-backend@sha256:dd124837e8956918aad20c93a5baff31798f5d2496256ffbe651547e8e8ff6df` ([handoff de Audio Inbox](https://github.com/undercodeec/hermes_n8n/blob/docs/inbox-audio-release-handoff/ProyectMD/HERMES_AUDIO_INBOX_RELEASE_HANDOFF_2026-10-29.md)). Por historial, el código nuevo conserva el endpoint de audio de Inbox. La comparación desde `bae4abe` hasta `1fa0e13` solo cambia el informe y ocho archivos de `auto-replies`, `voice` y `meta`; no cambia el frontend, `Dockerfile`, dependencias, Prisma, migraciones, esquema ni variables de entorno.

El fallback envía una plantilla determinista con primer nombre validado o `Hola. 😊`, sin detalles técnicos para el cliente. El diagnóstico interno clasifica el fallo y conserva datos estructurados saneados. La ruta normal de transcripción y entrega a Nous no cambia; el fallback sigue usando el ledger de `SYSTEM_NOTICE` y el turno entrante para impedir disculpas duplicadas. El informe de implementación y sus pruebas están en [HERMES_AUDIO_FALLBACK_HUMANIZATION_REPORT.md](HERMES_AUDIO_FALLBACK_HUMANIZATION_REPORT.md).

## Verificación local y de publicación

| Comprobación | Resultado |
| --- | --- |
| Backend Jest completo, mocks y datos sintéticos | 98 suites, 1580 pruebas aprobadas |
| `npm run build` | Aprobado |
| ESLint de los ocho archivos de código y pruebas modificados | Aprobado |
| ESLint global sin `--fix` | 60 errores y 7 avisos en archivos fuera del cambio; deuda previa, no corregida aquí |
| `git diff --check` del delta promocionado | Aprobado |
| GitHub Actions manual | Run `40964181232`, `success`; pasos de SHA, tree, publicación, arquitectura, pull y etiqueta OCI aprobados |
| GHCR desde Codex Local | Índice por digest disponible y manifiesto `linux/amd64` confirmado |

El workflow emitió un aviso no bloqueante sobre la transición de algunas Actions desde Node.js 20 a Node.js 24. El código fuente y el Dockerfile no se cambiaron por ese aviso.

## Preflight y despliegue pendientes para Codex VPS

1. Leer el estado de release productivo real (`/root/evidence/hermes-release-state/current.json`, Compose y contenedor efectivo) y verificar que la versión servida sea compatible. El digest Audio Inbox anterior es una referencia publicada, **no** una afirmación sobre la imagen que esté sirviendo la VPS en ese momento.
2. Confirmar acceso de la VPS a GHCR y pull del digest inmutable nuevo antes de modificar Compose. Revisar salud, colas y entregas ambiguas, recursos, flags Nous, locks y rollback efectivo siguiendo el procedimiento VPS autorizado.
3. Desplegar exclusivamente el servicio backend `app` con el digest indicado mediante el procedimiento Compose validado. No se requieren migraciones ni variables nuevas. Conservar la configuración vigente de Nous, STOP, handoff y F3/F4.
4. Comprobar salud del backend, flujo normal de audio hacia Nous y fallback ante fallo controlado si el procedimiento productivo lo autoriza, sin generar tráfico WhatsApp real innecesario. Confirmar que Inbox sigue sirviendo audio y que no aparecen respuestas duplicadas. Registrar identidad servida y resultados reales antes de declarar el despliegue completo.

**Rollback esperado:** si hay regresión, restaurar únicamente el digest backend `app` que Codex VPS haya verificado como efectivo inmediatamente antes del cambio, sin revertir datos ni reenviar entregas de estado incierto. El digest Audio Inbox `sha256:dd124…ff6df` solo puede usarse como rollback si el preflight confirma que sigue siendo la versión anterior aplicable.

**Riesgos pendientes:** no se conoce la causa del fallo de voz observado en producción sin logs productivos; el acceso GHCR desde VPS y el comportamiento con Meta/ElevenLabs reales quedan para validación allí; los medios de Meta pueden expirar; el lint global preexistente sigue fallando. `READY_FOR_VPS_DEPLOY` acredita el artefacto local y GHCR, no la salud ni el estado de la VPS.
