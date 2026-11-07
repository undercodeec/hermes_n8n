# Hermes 2.0 — A7-BF16: publicación GHCR y sincronización documental

**Dictamen:** `HERMES_A7_BF16_GHCR_PUBLISHED_DOCS_SYNCED` una vez abierto el PR documental y comprobados los enlaces indicados abajo. **Fecha:** 7/11/2026. **Alcance:** publicación de imagen e informe; sin despliegue ni cambios comerciales.

## A. Identidades y resultado GHCR

| Campo | Identidad comprobada |
| --- | --- |
| Repositorio | `undercodeec/hermes_n8n` |
| Rama piloto remota | `pilot/a7-d12-monitor-only-20261026` |
| HEAD piloto / `source_sha` | `49a7f6adf3776e81fae9675f66b12ad48271dcf3` |
| Git tree / `expected_tree` | `0498f5bf38b4645858bf67fce42017f0c6ec1572` |
| PR integrado | [#15](https://github.com/undercodeec/hermes_n8n/pull/15), fusionado |
| Workflow manual ejecutado desde `main` | [`.github/workflows/hermes-backend-ghcr-manual.yml`](https://github.com/undercodeec/hermes_n8n/blob/main/.github/workflows/hermes-backend-ghcr-manual.yml) |
| Run y job | [#42389504813](https://github.com/undercodeec/hermes_n8n/actions/runs/42389504813), job `128453897159`; `success` |
| Etiqueta única de esta ejecución | `ghcr.io/undercodeec/hermes-backend:49a7f6adf3776e81fae9675f66b12ad48271dcf3-run42389504813-attempt1` |
| Referencia inmutable | `ghcr.io/undercodeec/hermes-backend@sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b` |
| Plataforma ejecutable | `linux/amd64`; manifiesto OCI `sha256:9757308ffe89ed2624911e3aee9a9cdcd56700758409ad06414ee7ad1f6d0347` |
| OCI `org.opencontainers.image.revision` | `49a7f6adf3776e81fae9675f66b12ad48271dcf3` |

El workflow validó el HEAD remoto piloto, hizo checkout del commit exacto, contrastó su tree, construyó y publicó, extrajo la imagen para `linux/amd64` y comprobó la etiqueta OCI. Los pasos de compilación/publicación y verificación terminaron `success`. Una inspección adicional desde Codex Local resolvió la etiqueta única y la referencia por digest al mismo índice OCI. La entrada `unknown/unknown` del índice es una attestation de Buildx; el manifiesto ejecutable es `linux/amd64`. El commit de `main` que contiene el workflow es `50c3d0f005683ef294d29cb6fab86fb4a8e134e1`; el código de la imagen procede del commit piloto anterior.

## B. Validaciones, límites e incidencias

Antes del dispatch, `git ls-remote` y la API de GitHub confirmaron el HEAD piloto exacto; la API de Git devolvió el tree exacto. El PR #15 continuaba `merged=true`. El workflow estaba `active` en `main` y permitía dispatch con `contents: read` y `packages: write`. El diff del PR #15 respecto del piloto anterior no modificó Dockerfile, workflows, dependencias ni migraciones; `git diff --check` aprobó. No se sustituyeron los parámetros por los valores predeterminados históricos del workflow.

Las pruebas del commit integrado ya aprobadas en [A7-BF15](HERMES_A7_BF15_MERGE_REPORT_2026-11-07.md) fueron 1906 unitarias, 233 comerciales, 298 focalizadas, 188 integraciones aisladas y 31 A7-D16, además de TypeScript, build, ESLint, Prisma, secretos y auditoría de dependencias productivas. A7-BF16 no repitió esas suites; el build Docker y la verificación OCI ocurrieron en Actions. Ninguna de estas pruebas certifica el CRM ni el runtime productivo actual.

**Incidencia de herramienta sin impacto en la publicación:** la API respondió con cuerpo vacío al aceptar el dispatch; el comando local intentó leer una propiedad de esa respuesta y mostró un error. Se confirmó inmediatamente el nuevo run #42389504813 en Actions, con parámetros y pasos de identidad aprobados. El run terminó `success` y el digest se recuperó de sus logs y de GHCR. No se reintentó el dispatch.

## C. Estado productivo

**No se desplegó en VPS.** No se modificó Docker Compose, ninguna variable productiva, PostgreSQL, Redis, CRM ni PriceList. No se ejecutaron migraciones, no se activó F3/F4 ni aprendizaje automático y no hubo envíos Meta o WhatsApp reales. No se verificó el digest servido por Docker en producción.

La última imagen productiva **reportada** por el informe VPS del 5/11, resumido en el [estado documental del PR #14](https://github.com/undercodeec/hermes_n8n/blob/docs/hermes-status-20261107/ProyectMD/ESTADO-ACTUAL-HERMES-2026-11-07.md), es `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`, revisión `88e9712fd6e16a730fcfd00acee10a25e84a429b`. Allí se informó saludable en aquel corte. La referencia de rollback entonces citada fue `ghcr.io/undercodeec/hermes-backend@sha256:5efdd8b8f8be60ca2eea42e492bd80d95453b808a234101508c1c8fb426c3e89`. Su estado actual y su recuperabilidad requieren comprobación en A7-BF17. Los informes A7-D27 del 29/10 y R6 del 26/10 son anteriores; no representan por sí solos el último runtime conocido.

## D. Documentación accesible desde GitHub

La rama `docs/hermes-a7-bf16-20261107` parte del HEAD remoto de `main`, sin modificar la rama piloto. Publica únicamente los siguientes Markdown revisados:

1. [A7-BF15: merge y QA](HERMES_A7_BF15_MERGE_REPORT_2026-11-07.md).
2. [A7-BF16: publicación GHCR y handoff](HERMES_A7_BF16_GHCR_PUBLICATION_REPORT_2026-11-07.md).
3. [Índice y precedencia documental](INDICE-Y-PRECEDENCIA-DOCUMENTAL-2026-11-07.md).

**PR documental:** por registrar al abrirlo. **Commit documental inicial:** por registrar tras el primer commit. Las referencias definitivas a estos archivos son las de la rama y el PR, hasta que este último sea revisado y fusionado.

El [informe Black Friday](https://github.com/undercodeec/hermes_n8n/blob/pilot/a7-d12-monitor-only-20261026/ProyectMD/HERMES_BLACK_FRIDAY_CONVERSATION_FIX_2026-11-07.md) ya se incorporó en el PR #15 y no se duplicó. El [PR #14](https://github.com/undercodeec/hermes_n8n/pull/14) permanece como borrador abierto, sin fusión: su diagnóstico de corrección pendiente es histórico desde el merge #15; el inventario y la evidencia productiva del 5/11 conservan utilidad con su fecha original.

**Material excluido por privacidad o falta de vigencia:** informes internos de VPS, `current.json`, logs, backups, capturas y evidencias locales no se publicaron. El documento de incidencia del PR #14 contiene una conversación real y no se copió a este PR. La versión pública de A7-BF15 omite la transcripción de una consulta de cliente presente en el archivo local e indica expresamente esa redacción. Ningún archivo funcional se incluyó. Los tres Markdown fueron revisados para evitar secretos, identificadores privados, teléfonos y conversaciones reales.

## E. Handoff a Codex VPS: `HERMES_A7_BF17_PRODUCTION_PREFLIGHT`

La candidata exacta es `ghcr.io/undercodeec/hermes-backend@sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b`, commit `49a7f6adf3776e81fae9675f66b12ad48271dcf3`, tree `0498f5bf38b4645858bf67fce42017f0c6ec1572`, OCI revision idéntica al commit. El run de publicación es #42389504813. Esta identidad debe compararse con la imagen efectivamente servida, sin asumir que ya está desplegada.

En preflight **de solo lectura**, comprobar estado oficial de release, Docker Compose renderizado, contenedor, digest e identidad OCI servidos, imagen anterior recuperable y compatibilidad del rollback. Revisar salud de PostgreSQL y Redis, migraciones aplicadas, colas y trabajos, entregas `PREPARED`/`AMBIGUOUS`, disco y memoria. Leer flags Nous efectivos sin alterarlos; preservar motor de conversaciones existentes, STOP, handoff, idempotencia y recuperación de entregas. F3/F4 deben seguir desactivados salvo autorización separada.

Con acceso autorizado y de solo lectura al CRM, comprobar promoción Black Friday activa y seleccionable, precio USD 80, diez prestaciones y duración de soporte realmente almacenada. El código admite una respuesta basada en `scope`, pero no prueba que el dato productivo sea de doce meses. No modificar tarifas ni reintentar entregas ambiguas durante el preflight.

**Condiciones antes de proponer despliegue:** identidad y salud productiva verificadas, rollback recuperable y compatible, trabajos/ledger protegidos, compatibilidad de migraciones y configuración confirmada, estado comercial real conocido y autorización de despliegue aparte. La publicación GHCR y este PR documental no conceden esa autorización.
