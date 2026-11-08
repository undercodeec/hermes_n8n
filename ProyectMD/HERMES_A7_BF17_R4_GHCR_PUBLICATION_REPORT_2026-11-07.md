# Hermes 2.0 — A7-BF17-R4: publicación GHCR

**Dictamen:** `HERMES_A7_BF17_R4_GHCR_PUBLISHED`
**Fecha:** 2026-11-07
**Alcance:** publicación y verificación de imagen; sin despliegue ni cambios productivos.

## Autorización y preflight

El propietario autorizó expresamente `PUBLISH_GHCR_A7_BF17_R4` para el commit piloto `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`, tree `0f1b57434021587dd46347f03629ac9bac82122f`, workflow `.github/workflows/hermes-backend-ghcr-manual.yml` y ejecución desde `main`. La autorización incluye documentación pública saneada; excluye VPS, datos productivos, CRM, envíos Meta y fusión automática de PR documentales.

El preflight directo en GitHub confirmó que el [PR #17](https://github.com/undercodeec/hermes_n8n/pull/17) seguía fusionado, que la rama piloto no tenía commits posteriores y que su tree coincidía exactamente. El diff integrado contenía los diez archivos aprobados y ninguna migración nueva. El Dockerfile conservaba el blob `0a3879fccf3721331a34e1289be51a670a4fef8d`, idéntico al de la base piloto anterior. La rama `main` seguía en `50c3d0f005683ef294d29cb6fab86fb4a8e134e1` y el workflow manual conservaba el blob `95831a5141063b8c0cb75d828f6ed31631c683e8`. El workflow exige el HEAD piloto remoto y su tree antes de construir, hace checkout del commit exacto y sólo permite el dispatch desde `main`.

Las pruebas posteriores al merge están en el [informe A7-BF17-R3](HERMES_A7_BF17_R3_MERGE_REPORT_2026-11-07.md): 1.949 unitarias, 97 focalizadas, 297 comerciales seleccionadas, 192 integraciones aisladas y 31 A7-D16 aprobadas, más TypeScript, build, ESLint, Prettier, Prisma, secretos y auditoría. Son gates locales del commit integrado, no CI de GitHub.

## Publicación y verificación

Se ejecutó el [workflow manual desde `main`, run #42426065900](https://github.com/undercodeec/hermes_n8n/actions/runs/42426065900), con los parámetros autorizados, sin usar los valores predeterminados históricos:

```text
source_sha=ca85b991db1651f5bf500f3fb8e9db95ba9d56f0
expected_tree=0f1b57434021587dd46347f03629ac9bac82122f
```

El run `workflow_dispatch` terminó `success` en el intento 1. El job `128564490156` terminó `success`; tanto el paso de build/publicación como el de verificación de digest y revisión OCI aprobaron. El workflow hizo checkout del piloto autorizado aunque el run se originó en el HEAD de `main`.

| Identidad | Valor verificado |
| --- | --- |
| Etiqueta única | `ghcr.io/undercodeec/hermes-backend:ca85b991db1651f5bf500f3fb8e9db95ba9d56f0-run42426065900-attempt1` |
| Referencia inmutable | `ghcr.io/undercodeec/hermes-backend@sha256:c94fcecc47ee381b7a76f9a4fd07d1d4ed2aacdf19c812b3fc128c143b40123d` |
| Digest del índice OCI | `sha256:c94fcecc47ee381b7a76f9a4fd07d1d4ed2aacdf19c812b3fc128c143b40123d` |
| Manifiesto ejecutable | `sha256:d3545780a2516d2246a6653875ff8fd528d69192fdc1cbe7b0e2c47e89854c33`, `linux/amd64` |
| Revisión OCI | `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0` |
| Comando de arranque | `docker-entrypoint.sh` → `node dist/main.js`, directorio `/app` |

Los logs de Actions muestran el push del índice OCI con ese digest y el paso posterior resuelve la referencia inmutable. Una comprobación adicional desde Codex Local descargó la imagen por digest y obtuvo el mismo `RepoDigest`, plataforma `linux/amd64` y revisión OCI exacta. El índice contiene también una entrada `unknown/unknown` de attestation de Buildx; el manifiesto ejecutable es el de `linux/amd64`. Un contenedor local temporal con red desactivada y sistema de archivos de sólo lectura confirmó `test -s /app/dist/main.js` y `node --check /app/dist/main.js`. No se inició el servicio contra sistemas externos.

La nueva imagen incluye el código piloto que ya integra Black Friday y la corrección del Webhook Inbox. No se reutilizó el digest de A7-BF16.

## Documentación y límites

Los informes públicos R3 y R4 y el [índice de precedencia](INDICE-Y-PRECEDENCIA-DOCUMENTAL-2026-11-07.md) se consolidaron en la rama documental del [PR #16](https://github.com/undercodeec/hermes_n8n/pull/16), que parte de `main`. Se preservaron los informes anteriores. El [PR #18](https://github.com/undercodeec/hermes_n8n/pull/18) conserva su informe R3 original y permanece separado; no se fusionó. La sincronización documental significa que los Markdown están accesibles en GitHub, no que el PR #16 esté fusionado.

La revisión focalizada de los tres Markdown añadidos o modificados no encontró patrones de claves, tokens, URLs con credenciales ni delimitadores de claves privadas. El escaneo global del árbol basado en `main` reportó dos hallazgos preexistentes en fixtures de aprendizaje, fuera del diff documental; sus blobs son idénticos a los de `main` y no se reprodujeron en los informes. No se alteraron esos archivos en R4.

**Producción no cambió en R4.** No se accedió a la VPS ni se comprobó el digest efectivamente servido. El último corte productivo documentado en [A7-BF17-R1](HERMES_A7_BF17_R1_INCIDENT_DIAGNOSIS_2026-11-07.md) corresponde a un backend anterior; no debe confundirse con esta imagen nueva. Siguen pendientes `BACKUP_RESTORE_NOT_VERIFIED`, reconciliación de los 23 archivos Compose en `current.json`, tratamiento autorizado del evento `FAILED`, evaluación del incidente de credenciales, nuevo preflight productivo y autorización independiente del despliegue.

No se ejecutaron Docker Compose productivo, reinicios, migraciones, modificaciones en PostgreSQL, Redis o CRM, envíos WhatsApp, operaciones comerciales A/B, rotación de credenciales ni activación F3/F4. La referencia por digest es la candidata para el siguiente preflight, no una instrucción de despliegue.
