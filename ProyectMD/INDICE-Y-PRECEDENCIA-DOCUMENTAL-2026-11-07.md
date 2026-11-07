# Hermes 2.0 — Índice y precedencia documental (7/11/2026)

> Para integrar en `ProyectMD/` mediante rama documental separada. **La documentación no equivale a un deploy, un cambio de base de datos ni un PR funcional.** No publicar evidencia privada del VPS, secretos, mensajes o identificadores de clientes.

## Lectura vigente, por orden

1. **`ESTADO-ACTUAL-HERMES-2026-11-07.md`** — dictamen consolidado del backend, QA, catálogo y riesgo conversacional. Es la portada actual del proyecto.
2. **`HERMES_NOUS_BLACK_FRIDAY_RESPUESTAS_PENDIENTE_2026-11-07.md`** — incidente del 7/11, causa probable en código, formato nuevo aprobado y pruebas de aceptación. **Pendiente de implementación**, no declarar resuelto.
3. **`HERMES_CATALOGO_COMERCIAL_ESTADO_Y_AUTORIZACIONES_2026-11-07.md`** — nueve planes, tres Landing, promoción independiente USD 80, regla de 12 meses y gates de escrituras A/B.
4. `HERMES_BACKEND_PRODUCTION_DEPLOY_RETRY_2026-11-05.md` — evidencia histórica del **último backend reportado sirviendo** en VPS; archivo de operador, no subir automáticamente a GitHub público.
5. `HERMES_CRM_COMMERCIAL_ACTIVATION_PREPARED_2026-11-05.md` — inventario y preflights reales; evidencia privada de operador, no subir sin revisión.
6. `HERMES_DOCKER_ENTRYPOINT_FIX_HANDOFF_2026-11-05.md` — reparación PR #13 y publicación GHCR.

## Precedencia temporal

- **29/10 A7-D27:** corte anterior; no usar su digest backend como «actual» después del informe del 5/11.
- **02/11 Black Friday visual:** documento histórico que define **tres** partes para «qué incluye» y respuesta **breve** para información general. Este formato es el que está en código desplegado al 5/11, pero **ya no satisface el requisito formulado el 7/11**. No editar su acta histórica; el nuevo documento marca el cambio pendiente.
- **04/11 opción B:** decisión comercial de 12 meses para los nueve planes, implementada en scripts/preflight pero **no aplicada** a base GLOBAL.
- **05/11 primer despliegue:** `HERMES_BACKEND_DEPLOY_ROLLED_BACK` por entrypoint. Histórico y superado por PR #13 + segundo despliegue.
- **05/11 segundo despliegue:** `HERMES_BACKEND_DEPLOYED_CRM_ACTIVATION_PENDING`; imagen `sha256:f669a608…b730` reportada sana.
- **05/11 preparación A/B:** `HERMES_CRM_ACTIVATION_PREPARATION_BLOCKED` por ausencia de backup restaurado y evidencias/autorizaciones independientes. Preflights limpios no autorizan `--apply`.
- **07/11:** incidencia conversacional Black Friday y ratificación de **12 meses para todos**; no hay PR correctivo, nueva imagen, prueba en VPS o aplicación comercial registrados en estas fuentes.

## Cambios documentales incluidos

Se crean estos cuatro Markdown y se añade una nota de precedencia al inicio de `ProyectMD/estado-proyecto.md` **sin borrar ni reescribir el historial anterior**. Esta entrega no toca TypeScript, Docker, migraciones, flags, Meta ni PriceList.

## Sincronización local

Si se integra el PR documental, ejecutar `git fetch origin`, comprobar rama/HEAD y `git pull --ff-only` desde la rama de trabajo apropiada (o integrar mediante el flujo habitual). Para un trabajo local sin merge, descargar el ZIP y copiar solo los archivos de `ProyectMD/` tras comparar modificaciones existentes. `.gitignore` incluye `*.md` en algunas configuraciones: si se integran manualmente, usar `git add -f ProyectMD/<archivo>.md` **únicamente** para las rutas revisadas.

## Estado del alcance

**Documentación actualizada**; **respuesta Black Friday pendiente de corrección**; **catálogo productivo pendiente A/B**; **backend productivo reportado estable al 5/11**. Cualquier nueva evidencia prevalecerá por fecha y verificación, no por el nombre del documento.
