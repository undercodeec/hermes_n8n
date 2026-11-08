# Hermes 2.0 — índice y precedencia documental (A7-BF17-R6, 8/11/2026)

El corte vigente es el preflight de reconciliación Compose A7-BF17-R6. La lectura actual de la VPS prevalece sobre estados históricos; la publicación GHCR no acredita despliegue. R6 no modificó producción.

## Corte vigente: A7-BF17-R6, 8/11/2026

**Dictamen:** `HERMES_A7_BF17_R6_RECONCILIATION_READY`. **Documentación:** `DOCS_SYNC_PENDING` hasta publicar y verificar el [informe R6](HERMES_A7_BF17_R6_COMPOSE_RECONCILIATION_PREFLIGHT_2026-11-08.md) en el [PR #16](https://github.com/undercodeec/hermes_n8n/pull/16). El PR no se fusionó.

| Tema | Estado y precedencia |
| --- | --- |
| Producción comprobada | `hermes-app` sigue en `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`, revisión `88e9712fd6e16a730fcfd00acee10a25e84a429b`; contenedor en ejecución, HTTP 200. La candidata R4 no está desplegada. |
| Compose | Docker utiliza 23 archivos; `current.json` registra exactamente los primeros 22 en el mismo orden. Falta el override final del 5/11. El render con 23 archivos reproduce el render histórico de ese despliegue; la reconciliación requiere `HERMES_A7_BF17_R6_RECONCILE_STATE`. El cálculo auxiliar `config --hash app` difiere de la etiqueta y requiere explicación antes de un futuro `up`. |
| Inbox | Un evento `FAILED` de tipo `MESSAGE` subió de 5.673 a 5.676 intentos durante R6; no tiene mensaje ni entrega asociados. Tratamiento posterior separado y autorizado. |
| Seguridad | Existe nota privada de exposición accidental de credenciales; evaluación de cierre no acreditada. Rotación, si procede, es operación separada. |
| Backup | `BACKUP_RESTORE_DEFERRED_OWNER_RISK_ACCEPTED` y `BACKUP_RESTORE_NOT_VERIFIED`. El propietario pospuso backup y restauración hasta ampliar la VPS; deuda técnica y riesgo aceptado, sin autorización de despliegue. |
| Candidata | El digest R4 `sha256:c94fcecc47ee381b7a76f9a4fd07d1d4ed2aacdf19c812b3fc128c143b40123d` sigue disponible en GHCR; `linux/amd64`, OCI revision `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`, workflow #42426065900 exitoso. |

## Corte anterior: A7-BF17-R4, 7/11/2026

**Dictamen:** `HERMES_A7_BF17_R4_GHCR_PUBLISHED`. **Documentación:** informes R3 y R4 consolidados en la rama documental del [PR #16](https://github.com/undercodeec/hermes_n8n/pull/16), basada en `main`; el PR sigue como borrador y no está fusionado. Consultar el [informe R4](HERMES_A7_BF17_R4_GHCR_PUBLICATION_REPORT_2026-11-07.md) y el [informe R3](HERMES_A7_BF17_R3_MERGE_REPORT_2026-11-07.md).

| Tema | Estado y precedencia |
| --- | --- |
| Código piloto | [PR #17](https://github.com/undercodeec/hermes_n8n/pull/17) fusionado; commit `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`, tree `0f1b57434021587dd46347f03629ac9bac82122f`. Contiene Black Friday e Inbox. Las pruebas posteriores constan en R3. |
| Imagen GHCR nueva | `ghcr.io/undercodeec/hermes-backend@sha256:c94fcecc47ee381b7a76f9a4fd07d1d4ed2aacdf19c812b3fc128c143b40123d`, publicada y verificada por el [run #42426065900](https://github.com/undercodeec/hermes_n8n/actions/runs/42426065900), `linux/amd64`, OCI revision `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`. Sustituye a A7-BF16 como candidata más reciente, sin invalidar su registro histórico. |
| Producción | **Sin despliegue ni verificación VPS en R4.** La última evidencia productiva documentada en R1 señala un backend anterior. No inferir la identidad actual del contenedor a partir de GHCR. |
| Bloqueos | `BACKUP_RESTORE_NOT_VERIFIED`; reconciliación de los 23 archivos Compose en `current.json`; tratamiento seguro del evento `FAILED`; evaluación de credenciales expuestas; nuevo preflight productivo y autorización independiente del despliegue. |

## Corte anterior: A7-BF17-R3, 7/11/2026

La integración del PR #17 y sus gates posteriores están descritos en [R3](HERMES_A7_BF17_R3_MERGE_REPORT_2026-11-07.md). El informe se copió sin cambios desde el [PR documental #18](https://github.com/undercodeec/hermes_n8n/pull/18) a la rama del PR #16 para consolidarlo con R4 sobre `main`. Ninguno de esos PR documentales se fusionó automáticamente.

## Corte anterior: A7-BF17-R1, 7/11/2026 16:48:36 UTC

**Dictamen:** `HERMES_A7_BF17_R1_ROOT_CAUSE_CONFIRMED`. **Documentación:** `DOCS_SYNC_PENDING` hasta verificar este índice y el [informe público A7-BF17-R1](HERMES_A7_BF17_R1_INCIDENT_DIAGNOSIS_2026-11-07.md) en el PR #16.

| Tema | Estado verificado en VPS |
| --- | --- |
| Backend servido | Permanece en el commit `88e9712fd6e16a730fcfd00acee10a25e84a429b`, imagen `sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`. La candidata A7-BF16 no está desplegada. |
| INC-01 | Un evento `MESSAGE` sigue `FAILED`, con 5.276 intentos al corte. El stack y el payload saneado confirman `message.from` y `contact.wa_id` ausentes; `normalizeWhatsAppId()` ejecuta `.trim()` sobre `undefined`. No hay mensaje ni entrega persistida para ese evento. Se propone corrección focalizada y cuarentena trazable, sin reintento infinito. |
| BACKUP-01 | PostgreSQL 16.14; volumen de backups vacío, última evidencia de catálogo del 25/10 sin restauración aislada. `BACKUP_RESTORE_NOT_VERIFIED`. |
| STATE-01 | La etiqueta Docker contiene 23 archivos Compose; `current.json` registra 22 y omite el override final del 5/11. El render completo reproduce imagen, revisión OCI y entorno efectivo; reconciliación pendiente. |

Priorizar la corrección del inbox mediante Codex Local, PR independiente y pruebas. Preparar después backup/restauración aislada y reconciliación de metadatos con autorizaciones separadas. No solicitar todavía despliegue A7-BF18.

## Corte anterior: A7-BF17, 7/11/2026 16:23:38 UTC

**Dictamen:** `HERMES_A7_BF17_PRODUCTION_BLOCKED`. **Documentación:** `DOCS_SYNC_PENDING` hasta verificar ambos archivos en el PR #16. Consultar el [informe público A7-BF17](HERMES_A7_BF17_PRODUCTION_PREFLIGHT_2026-11-07.md).

| Tema | Estado verificado en VPS |
| --- | --- |
| Backend servido | `hermes-app`, commit/OCI `88e9712fd6e16a730fcfd00acee10a25e84a429b`, imagen `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`, sin reemplazo observado desde el 5/11. |
| Candidata y rollback de A7-BF18 | Candidata GHCR `sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b`, aún sin desplegar; rollback natural: imagen servida `f669a608…`, disponible localmente y en GHCR. |
| Infraestructura | PostgreSQL 16.14 y Redis responden; 27 migraciones aplicadas, 0 fallidas; 0 trabajos Nous en espera/activos; ledger con 0 `PREPARED`, 0 `AMBIGUOUS`, 85 `CONFIRMED` y 4 `SUPPRESSED`. |
| CRM | Promoción Black Friday GLOBAL/USD 80 activa, diez prestaciones, 12 meses de soporte, `taxMode=NULL`; inventario 1 Product, 2 PriceLists, 0 tarifas EC. A/B no aplicadas. |
| Bloqueos | Un evento de inbox `FAILED` sigue reclamado y reintentándose con miles de intentos; `WebhookService.trim` continúa frecuente. `BACKUP_RESTORE_NOT_VERIFIED`. `current.json` omite el último override Compose aunque su imagen/commit/ID coinciden con Docker. |

No solicitar todavía autorización de despliegue A7-BF18. Resolver el ciclo del inbox, validar backup/restauración, reconciliar la cadena Compose y repetir el preflight. El despliegue y toda prueba WhatsApp real requieren autorización separada.

## Corte histórico: A7-BF16

## Estado y precedencia

| Tema | Evidencia vigente y límite |
| --- | --- |
| Integración Black Friday | [PR #15](https://github.com/undercodeec/hermes_n8n/pull/15) fusionado el 7/11 en el piloto; commit `49a7f6adf3776e81fae9675f66b12ad48271dcf3`, tree `0498f5bf38b4645858bf67fce42017f0c6ec1572`. |
| QA del commit integrado | [Informe A7-BF15](HERMES_A7_BF15_MERGE_REPORT_2026-11-07.md): 1906 unitarias, 233 comerciales, 298 focalizadas, 188 integraciones aisladas y 31 A7-D16; gates TypeScript, build, ESLint, Prisma, secretos y auditoría productiva aprobados. Son pruebas locales, no una prueba en producción. |
| Imagen nueva en GHCR | `ghcr.io/undercodeec/hermes-backend@sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b`; [run #42389504813](https://github.com/undercodeec/hermes_n8n/actions/runs/42389504813) aprobado. Consultar el [informe A7-BF16](HERMES_A7_BF16_GHCR_PUBLICATION_REPORT_2026-11-07.md). |
| Despliegue A7-BF16 | **Pendiente**. No se accedió a la VPS ni se cambió el runtime en esta operación. |
| PR documental anterior | [PR #14](https://github.com/undercodeec/hermes_n8n/pull/14), abierto como borrador y sin fusionar. Se creó antes del merge #15; no se fusionó ni se copiaron sus documentos íntegros. |

## Versiones que no deben confundirse

| Concepto | Última evidencia conocida |
| --- | --- |
| Última versión productiva documentada | Informe VPS del 5/11 resumido en el [PR #14](https://github.com/undercodeec/hermes_n8n/pull/14): commit `88e9712fd6e16a730fcfd00acee10a25e84a429b`, imagen `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`. |
| Versión efectivamente verificada | El informe VPS del 5/11 reportó saludable esa imagen en aquel corte. A7-BF16 no repitió la verificación en VPS. |
| Imagen GHCR publicada en A7-BF16 | `ghcr.io/undercodeec/hermes-backend@sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b`. Es candidata para el preflight, no identidad del contenedor productivo. |
| Imagen realmente servida por Docker ahora | **Desconocida hasta A7-BF17**, que debe contrastar Docker/Compose con la revisión OCI. |
| Versión preparada para rollback | El informe del 5/11 citó `ghcr.io/undercodeec/hermes-backend@sha256:5efdd8b8f8be60ca2eea42e492bd80d95453b808a234101508c1c8fb426c3e89`. Recuperabilidad y compatibilidad actuales: pendientes de A7-BF17. |

El corte A7-D27 del 29/10 (`e673417b9f2fa959959c5e0a75fad1d08d006388`) y R6 del 26/10 son históricos; la evidencia VPS del 5/11 tiene precedencia temporal. Tampoco se debe tratar una publicación GHCR del 7/11 como una comprobación del runtime.

## Documentos y decisiones

- **Actuales para esta operación:** [A7-BF15, merge y QA](HERMES_A7_BF15_MERGE_REPORT_2026-11-07.md), [A7-BF16, GHCR y handoff](HERMES_A7_BF16_GHCR_PUBLICATION_REPORT_2026-11-07.md), y este índice.
- **Código y comportamiento integrado:** [corrección Black Friday del PR #15](https://github.com/undercodeec/hermes_n8n/blob/pilot/a7-d12-monitor-only-20261026/ProyectMD/HERMES_BLACK_FRIDAY_CONVERSATION_FIX_2026-11-07.md). Su despliegue y la configuración comercial real siguen pendientes.
- **Históricos, disponibles en el borrador #14:** estado al 7/11 antes del merge y [catálogo y autorizaciones](https://github.com/undercodeec/hermes_n8n/blob/docs/hermes-status-20261107/ProyectMD/HERMES_CATALOGO_COMERCIAL_ESTADO_Y_AUTORIZACIONES_2026-11-07.md). El diagnóstico de respuesta pendiente contiene una conversación real y no se incorporó aquí. Su descripción de la incidencia como «sin PR correctivo» quedó superada por #15; la evidencia productiva y los bloqueos comerciales conservan su fecha y alcance.
- **Rollback:** referencias de imagen del informe VPS del 5/11; la decisión de rollback requiere preflight de recuperabilidad y compatibilidad. No usar R6 ni A7-D27 automáticamente.

## Deudas y siguiente fase

Siguen abiertos el preflight productivo, la confirmación de la oferta Black Friday activa (USD 80, diez prestaciones y soporte realmente almacenado), los mantenimientos comerciales A/B aún sin aplicar, la comprobación de backup/restauración y la vigilancia del error histórico de `WebhookService.trim`. Ninguna decisión comercial autoriza escrituras en CRM durante A7-BF16.

En el corte A7-BF16, la siguiente operación era **`HERMES_A7_BF17_PRODUCTION_PREFLIGHT`**, de solo lectura, por Codex VPS. Su resultado figura en el informe A7-BF17 enlazado arriba. El [informe A7-BF16](HERMES_A7_BF16_GHCR_PUBLICATION_REPORT_2026-11-07.md) conserva el handoff histórico.
