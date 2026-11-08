# Hermes 2.0 — A7-BF17-R6: preflight de reconciliación Compose

**Corte de ejecución:** 2026-11-07 23:55–2026-11-08 00:01 UTC. **Dictamen:** `HERMES_A7_BF17_R6_RECONCILIATION_READY`. **Documentación:** `DOCS_SYNC_PENDING` hasta publicar y verificar estos Markdown en el [PR #16](https://github.com/undercodeec/hermes_n8n/pull/16). R6 fue exclusivamente diagnóstica en producción; `current.json` no se modificó.

## 1. Fuentes y precedencia

Se consultaron directamente en GitHub los informes [A7-BF17](HERMES_A7_BF17_PRODUCTION_PREFLIGHT_2026-11-07.md), [R1](HERMES_A7_BF17_R1_INCIDENT_DIAGNOSIS_2026-11-07.md), [R3](HERMES_A7_BF17_R3_MERGE_REPORT_2026-11-07.md), [R4](HERMES_A7_BF17_R4_GHCR_PUBLICATION_REPORT_2026-11-07.md) y el [índice](INDICE-Y-PRECEDENCIA-DOCUMENTAL-2026-11-07.md) de la rama documental. El estado leído ahora de Docker, PostgreSQL y el registro local prevalece sobre cortes históricos. El PR #16 seguía abierto y sin fusionar, HEAD `1d593f853a6cc062db16289f8e84025a8143a3db` al consultar.

## 2. Estado productivo

| Componente | Lectura de R6 |
| --- | --- |
| Backend | `hermes-app`, contenedor `a2baa02f199913449513f818431c08d5ec3d39bf786fdc78247c6b8025161bfe`, en ejecución, 0 reinicios, sin healthcheck Docker; `GET /api/docs` respondió 200. |
| Imagen servida | `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`, `linux/amd64`. |
| Revisión OCI | `88e9712fd6e16a730fcfd00acee10a25e84a429b`. |
| Auxiliares | `hermes-postgres`, `hermes-redis` y `hermes-n8n`: en ejecución, Docker healthy, 0 reinicios. |
| Compose | Proyecto `hermes-backend`, servicio `app`, directorio `/var/www/releases/hermes-20261017-f3-guard-99a5ec56/hermes-backend`, archivo de entorno `/etc/hermes-crm/compose.env`. |
| Registro | Imagen, commit, contenedor, proyecto, servicio, directorio y archivo de entorno de `current.json` coinciden con Docker. |

**Discrepancia única de la cadena:** `compose_paths.files` registra 22 archivos. La etiqueta `com.docker.compose.project.config_files` del contenedor registra esos mismos 22, en idéntico orden, y añade como archivo 23 `/root/evidence/hermes-backend-production-deploy-retry-20261105/candidate.app.override.yml`. Los 23 existen y no hay rutas duplicadas. Este override final selecciona la imagen efectivamente servida. Los hashes siguientes fijan el estado observado; no son una autorización de cambio.

| Orden | En `current.json` | Archivo Compose efectivo | SHA-256 |
| --- | --- | --- | --- |
| 01 | Sí | `/var/www/releases/hermes-20261017-f3-guard-99a5ec56/hermes-backend/docker-compose.yml` | `eb76636d68138a2b2d6e223cd96e49c66431a2462a0e2976d8d590821beff344` |
| 02 | Sí | `/root/evidence/lf19k-b-20261023/candidate.image.yml` | `c0722e3fe84770498c2b43fc7cf25cb05aa95ce5e80599312449c71ae76c8f5b` |
| 03 | Sí | `/root/evidence/lf20r-d1-dark-20261024/dark.image.yml` | `2f2fa7fa17159d8fcf77538aea097d76863112c40ecd94bc78a864528fc55d99` |
| 04 | Sí | `/root/evidence/lf20r-w1-watchdog-f3-20261024/neutral.app.override.yml` | `67a2a53de0a5363233adddb84dd9c181c2479dca56e08a00506b470f9cf60185` |
| 05 | Sí | `/root/evidence/lf20r-a4-dark-20261025/candidate.app.override.yml` | `1759e4ed70ccb3a9d0f67d4cc979f3167d423a645ebaea0e16bb23428ee0f959` |
| 06 | Sí | `/root/evidence/lf20r-a6-d3-dark-20261025/candidate.a6.app.override.yml` | `a75b1346732e29ee555320a55631be7dbc9ee101fdcf54648c8291bcc773dcfd` |
| 07 | Sí | `/root/evidence/hermes-a7-d2-20261025/candidate.a7.app.override.yml` | `4815bc228a118fee5a45a6a29c93bfa6329dcaf766b79241cfbe8758a2168152` |
| 08 | Sí | `/root/evidence/hermes-a7-d6-20261026/candidate.a7d4.app.override.yml` | `429b3fc019188db4da95f4f6ab79476d3e2f326ae2b81d6e0e41d7ab7637d38b` |
| 09 | Sí | `/root/evidence/hermes-a7-d10-r6-20261026/candidate.a7d10.app.override.yml` | `8f7dc35588e62d115f89618601d16fa386706eedbf476fed4d33d0499d705c74` |
| 10 | Sí | `/root/evidence/hermes-a7-d14-g5-20261027/candidate.app.override.yml` | `394239f0e1133227c0b50d42c9639e6f2165ba42386e8a0c8bae17ad1d2ac59c` |
| 11 | Sí | `/root/evidence/hermes-a7-d19-20261028/candidate.app.override.yml` | `a634f50e9121339bc0ba4faeb6143812b0c74f24556059795b6e8f5e4e3cbd51` |
| 12 | Sí | `/root/evidence/hermes-a7-d20-20261028/activation.app.override.yml` | `18d9acee4095007215724e1ba633c62b273b1c70f9a43745685a7b0fa8dcab4e` |
| 13 | Sí | `/root/evidence/hermes-a7-d20-20261028/dark.app.override.yml` | `5ce19fe5067678d12ad767e820180c0d269f7a3a89faa090d4fef4a5f4ad0268` |
| 14 | Sí | `/root/evidence/hermes-a7-d20-retry-20261028/activation.app.override.yml` | `18d9acee4095007215724e1ba633c62b273b1c70f9a43745685a7b0fa8dcab4e` |
| 15 | Sí | `/root/evidence/hermes-a7-d27-20261029/candidate.app.override.yml` | `358fa60fbb35af291cad640a0e4b61a02045985ccb58ef09edc7c5e4c19fb0bd` |
| 16 | Sí | `/root/evidence/hermes-audio-inbox-20261029/candidate.app.override.yml` | `d6bed26db324c9251e3faf3e78395153ccab1a254a3ca6e70a66548dec213f03` |
| 17 | Sí | `/root/evidence/hermes-audio-fallback-20261029/candidate.app.override.yml` | `311f06e9fbbc1f74bfa31ac1241a3eff1d2a344a4fff84d8056b8413007363bd` |
| 18 | Sí | `/root/evidence/hermes-black-friday-catalog-recovery-20261030/candidate.app.override.yml` | `4b7887aa9b3cc722953c6527d5d8f6f66355d6fc0060e474e7c296e0833729f2` |
| 19 | Sí | `/root/evidence/hermes-crm-promotions-20261030/candidate.app.override.yml` | `6e48ebe13b84782220be8e549dc573e52186b0bc52c1f94ff7adfbdd8a1cc897` |
| 20 | Sí | `/root/evidence/hermes-black-friday-meta-ads-vps-20261031/candidate.app.override.yml` | `f95d2adb90943a1a93e24c37bc0be3e74b934e037fa07c78ca44e763a5fefddc` |
| 21 | Sí | `/root/evidence/hermes-nous-es-ec-final-20261031/candidate.app.override.yml` | `d10e054ddae6d7f2a910a31884156b75096a63a74f6b0f879ccda562a5d58ce0` |
| 22 | Sí | `/root/evidence/hermes-black-friday-release-20261102/candidate.app.override.yml` | `b689b417f1026f933a38b702fa596f34e156f6c6c565df3651f07ef56617dc64` |
| 23 | No | `/root/evidence/hermes-backend-production-deploy-retry-20261105/candidate.app.override.yml` | `39cab388eaa30044ba0eaf1a4fc043b3580460ce21a093128026f8ff288b3b18` |

SHA-256 de `current.json` leído: `8124bb3379497414c4c3c7433450fdccfd19349055731c7d21d57b0cb31fa816`.

## 3. Comparación de 22 y 23 archivos

Se ejecutó `docker compose config --format json` en memoria para ambas cadenas con el proyecto, directorio, archivo de entorno y revisión registrados. Ningún render completo se guardó o publicó. La comparación estructural completa encontró solo estas dos diferencias:

| Campo | 22 archivos | 23 archivos y Docker |
| --- | --- | --- |
| `services.app.image` | `ghcr.io/undercodeec/hermes-backend@sha256:5efdd8b8f8be60ca2eea42e492bd80d95453b808a234101508c1c8fb426c3e89` | `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730` |
| `services.app.environment.BACKEND_GIT_COMMIT` | `fb36afe2f62952ebb99848851ea8c862cc98ce79` | `88e9712fd6e16a730fcfd00acee10a25e84a429b` |

Servicios `app`, `postgres`, `redis`, `n8n`; redes `default`, `hermes_client_api`; volúmenes `hermes_backups`, `hermes_n8n_data`, `hermes_pgdata`, `hermes_redis_data`: sin diferencias entre los renders salvo esos dos campos. Los nombres de las 117 variables declaradas para `app` son iguales; sus valores renderizados se cotejaron en memoria con el entorno efectivo del contenedor y no hubo discrepancias. Docker añade tres variables de la imagen. No se publican valores, secretos ni renders. Los flags Nous, aprendizaje, comercio y Meta no cambian entre 22 y 23 archivos.

El SHA-256 canónico del render de 23 archivos es `cb22164ff6a9c04a529d88daf06c2553ffec80cb3159329d8bafe731a989dc03`, idéntico al preflight privado del despliegue del 5/11. Esto respalda que la configuración efectiva no cambió desde ese preflight. Como control auxiliar, `docker compose config --hash app` calculó `c67f634bf4421315fd9ef6be13c76890265676773a3314a030fada112e501824`, distinto de la etiqueta `com.docker.compose.config-hash` (`f34f89065282b48186e53deed827b9dd804025ddae84749a259620e3f26f1d3a`). Esa diferencia de cálculo queda pendiente de explicación antes de un futuro `up`; no altera la coincidencia del render canónico histórico, la imagen, la revisión ni el entorno. No se ejecutó `up` en R6.

## 4. Inbox Meta: handoff separado

PostgreSQL 16.14 respondió a consultas de solo lectura. Hay **1 evento `FAILED`**, tipo `MESSAGE`, creado el 3/11 a las 20:06:42 UTC. Identidad saneada: SHA-256 de `eventKey` `3540e2f3e865aa70e9da82c81c35593aa403d1b7c019acd5d908665949955ba1`. `outcome=processing_error`; `claimToken` ausente al corte; lease programado para 2026-11-07 23:59:52.576 UTC en la última lectura. El contador creció de **5.673** a **5.676** entre lecturas de R6; `updatedAt` alcanzó 2026-11-07 23:58:52.577 UTC. Continúa reintentándose. No hay mensajes ni entregas asociados por el identificador de mensaje del evento. La imagen correctiva R4 no está desplegada: el riesgo operativo sigue activo. La disposición del evento exige handoff y autorización separados; R6 no cambió estado, resultado, intentos, lease, claim ni payload, y no envió mensajes.

## 5. Seguridad y respaldo

Existe la nota **privada** de exposición accidental de credenciales de R1. La búsqueda de seguimiento en las evidencias de esta fase no halló un registro de evaluación cerrada o rotación completada. **Evaluación pendiente** para el futuro preflight; el responsable de seguridad debe revisar alcance y accesos a la salida afectada y, si corresponde, planificar rotación en operación separada. Esta nota y sus valores no se publican. R6 no modificó credenciales ni reinició servicios.

**`BACKUP_RESTORE_DEFERRED_OWNER_RISK_ACCEPTED`**. El propietario aplazó respaldos y restauraciones hasta ampliar la capacidad de la VPS y aceptó el riesgo temporal de no disponer de un respaldo reciente y restaurable. **`BACKUP_RESTORE_NOT_VERIFIED`** continúa como deuda técnica pendiente de ampliación. R5 no se ejecutó. R6 no generó dumps, copias de PostgreSQL, contenedores ni restauraciones. Esta decisión no autoriza el despliegue ni elimina los otros controles operativos.

## 6. Candidata GHCR, sin despliegue

GHCR respondió 200 al índice OCI `sha256:c94fcecc47ee381b7a76f9a4fd07d1d4ed2aacdf19c812b3fc128c143b40123d`. Su manifiesto ejecutable es `sha256:d3545780a2516d2246a6653875ff8fd528d69192fdc1cbe7b0e2c47e89854c33`, `linux/amd64`; el blob de configuración indica revisión OCI `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`. La rama piloto sigue en ese commit, tree `0f1b57434021587dd46347f03629ac9bac82122f`. El [workflow #42426065900](https://github.com/undercodeec/hermes_n8n/actions/runs/42426065900) y sus pasos de fuente, build, publicación y verificación terminaron `success`. La imagen no fue descargada en la VPS ni desplegada.

## 7. Procedimiento preparado para autorización separada

**Autorización requerida:** `HERMES_A7_BF17_R6_RECONCILE_STATE`. Sin ella no se escribe `current.json`. El cambio propuesto es añadir **solo** el archivo 23 al final de `compose_paths.files`; imagen, commit, ID, demás campos, Compose, entorno y contenedores permanecen intactos.

1. En una operación autorizada, adquirir sin espera y en orden documentado los locks `/run/lock/hermes-docker-operations.lock`, `/run/lock/hermes-release-state.lock` y `/run/lock/hermes-commercial-maintenance.lock`; abortar si alguno está ocupado. Comprobar que no hay despliegue ni mantenimiento concurrente y mantener los locks hasta terminar la verificación.
2. Releer Docker y `current.json` bajo lock. Exigir contenedor `a2baa02f199913449513f818431c08d5ec3d39bf786fdc78247c6b8025161bfe`, imagen `f669a608…`, revisión `88e9712…`, proyecto, servicio, directorio y env file esperados; exigir SHA-256 de `current.json` y 23 hashes del inventario anterior. Abortarlo ante cualquier cambio.
3. Exigir que los 22 registrados sean el prefijo exacto de los 23 de Docker y que el archivo 23 sea el override señalado, sin duplicados ni rutas ausentes. Renderizar ambas cadenas solo en memoria con salida saneada; exigir que el delta siga siendo exclusivamente `app.image` y `BACKEND_GIT_COMMIT`, que el render completo conserve el hash canónico histórico y que coincida con el runtime. Investigar la diferencia auxiliar de `config --hash` antes de cualquier futuro `up`.
4. Guardar una instantánea privada de **metadatos** de `current.json` con permisos 0600 y checksum para reversión; no copiar PostgreSQL. Preparar JSON nuevo cambiando únicamente `compose_paths.files`. Escribir en archivo temporal del mismo directorio con permisos 0600, `fsync` del archivo, reemplazo atómico y `fsync` del directorio. No cambiar `updated_at_utc` ni otros campos sin autorización específica.
5. Releer el JSON y comparar todas las claves salvo `compose_paths.files` con la instantánea; confirmar lista exacta de 23, hash nuevo, identidad Docker inalterada, HTTP 200 y salud de auxiliares. Registrar el resultado saneado y liberar locks en orden inverso.
6. Si falla la validación posterior, bajo los mismos locks y tras reconfirmar que no hubo despliegue concurrente, restaurar atómicamente **solo el archivo de metadatos** desde la instantánea, verificar su checksum y la identidad del contenedor, documentar el fallo y detenerse. No ejecutar Compose ni tocar datos.

## 8. Handoff A7-BF17-R7

R7 requiere su propia autorización. Debe ejecutar la reconciliación de metadatos solo tras `HERMES_A7_BF17_R6_RECONCILE_STATE` y sus gates; efectuar un nuevo preflight de Docker/Compose y candidato por digest; tratar por separado el evento `FAILED` sin perder trazabilidad ni duplicar entregas; cerrar o programar la evaluación del incidente de credenciales; mantener registrada la deuda `BACKUP_RESTORE_NOT_VERIFIED` bajo la decisión del propietario. La aceptación del riesgo de backups no autoriza R7 ni el despliegue. Ninguna intervención productiva, migración, envío Meta, activación comercial o cambio de imagen se realizó en R6.
