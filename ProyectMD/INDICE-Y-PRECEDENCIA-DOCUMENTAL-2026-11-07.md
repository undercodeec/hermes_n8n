# Hermes 2.0 — índice y precedencia documental (A7-BF16, 7/11/2026)

Este índice identifica el estado comprobado en A7-BF16. La publicación de una imagen no acredita un despliegue. Los informes anteriores conservan su fecha y alcance originales.

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
| Última versión productiva documentada | Informe VPS del 5/11 citado en el [estado del PR #14](https://github.com/undercodeec/hermes_n8n/blob/docs/hermes-status-20261107/ProyectMD/ESTADO-ACTUAL-HERMES-2026-11-07.md): commit `88e9712fd6e16a730fcfd00acee10a25e84a429b`, imagen `ghcr.io/undercodeec/hermes-backend@sha256:f669a608d0739fdfbdd687d83c0617208cd24be715365a4e10dae34241c3b730`. |
| Versión efectivamente verificada | El informe VPS del 5/11 reportó saludable esa imagen en aquel corte. A7-BF16 no repitió la verificación en VPS. |
| Imagen GHCR publicada en A7-BF16 | `ghcr.io/undercodeec/hermes-backend@sha256:959e80a4a6cfd8d65a33e38f7d52f9366a70a2b4fd8c526727cfa4955dce676b`. Es candidata para el preflight, no identidad del contenedor productivo. |
| Imagen realmente servida por Docker ahora | **Desconocida hasta A7-BF17**, que debe contrastar Docker/Compose con la revisión OCI. |
| Versión preparada para rollback | El informe del 5/11 citó `ghcr.io/undercodeec/hermes-backend@sha256:5efdd8b8f8be60ca2eea42e492bd80d95453b808a234101508c1c8fb426c3e89`. Recuperabilidad y compatibilidad actuales: pendientes de A7-BF17. |

El corte A7-D27 del 29/10 (`e673417b9f2fa959959c5e0a75fad1d08d006388`) y R6 del 26/10 son históricos; la evidencia VPS del 5/11 tiene precedencia temporal. Tampoco se debe tratar una publicación GHCR del 7/11 como una comprobación del runtime.

## Documentos y decisiones

- **Actuales para esta operación:** [A7-BF15, merge y QA](HERMES_A7_BF15_MERGE_REPORT_2026-11-07.md), [A7-BF16, GHCR y handoff](HERMES_A7_BF16_GHCR_PUBLICATION_REPORT_2026-11-07.md), y este índice.
- **Código y comportamiento integrado:** [corrección Black Friday del PR #15](https://github.com/undercodeec/hermes_n8n/blob/pilot/a7-d12-monitor-only-20261026/ProyectMD/HERMES_BLACK_FRIDAY_CONVERSATION_FIX_2026-11-07.md). Su despliegue y la configuración comercial real siguen pendientes.
- **Históricos, disponibles en el borrador #14:** [estado al 7/11 antes del merge](https://github.com/undercodeec/hermes_n8n/blob/docs/hermes-status-20261107/ProyectMD/ESTADO-ACTUAL-HERMES-2026-11-07.md) y [catálogo y autorizaciones](https://github.com/undercodeec/hermes_n8n/blob/docs/hermes-status-20261107/ProyectMD/HERMES_CATALOGO_COMERCIAL_ESTADO_Y_AUTORIZACIONES_2026-11-07.md). El diagnóstico de respuesta pendiente contiene una conversación real y no se incorporó aquí. Su descripción de la incidencia como «sin PR correctivo» quedó superada por #15; la evidencia productiva y los bloqueos comerciales conservan su fecha y alcance.
- **Rollback:** referencias de imagen del informe VPS del 5/11; la decisión de rollback requiere preflight de recuperabilidad y compatibilidad. No usar R6 ni A7-D27 automáticamente.

## Deudas y siguiente fase

Siguen abiertos el preflight productivo, la confirmación de la oferta Black Friday activa (USD 80, diez prestaciones y soporte realmente almacenado), los mantenimientos comerciales A/B aún sin aplicar, la comprobación de backup/restauración y la vigilancia del error histórico de `WebhookService.trim`. Ninguna decisión comercial autoriza escrituras en CRM durante A7-BF16.

La siguiente operación autorizable es **`HERMES_A7_BF17_PRODUCTION_PREFLIGHT`**, de solo lectura, por Codex VPS. Debe verificar imagen servida, rollback, infraestructura, colas, entregas y flags efectivos antes de proponer cualquier despliegue. El [informe A7-BF16](HERMES_A7_BF16_GHCR_PUBLICATION_REPORT_2026-11-07.md) contiene el handoff.
