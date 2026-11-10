# Estado canónico de Hermes — 2026-11-10

## Alcance y jerarquía de evidencia

Reconciliación documental del checkout `docs/project-reconciliation-20261110`, base `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`. No modifica código, infraestructura ni Hermes-web. No ejecuta migraciones, envíos WhatsApp ni activaciones. La auditoría de evidencia es de solo lectura; la publicación documental mediante commit, push y PR cuenta con autorización expresa y es una operación separada, cuya realización no se acredita aquí. El [corte de octubre](estado-proyecto-historico-2026-10.md) conserva sus resultados originales; no extrapolarlos a noviembre.

La fuente de verdad se compone de código por SHA, estado de PR, ejecución de workflow e identidad OCI; un documento no reemplaza esa evidencia. La producción requiere además inspección fechada del runtime. La API de GitHub se consultó en modo lectura el 10/11 para `main`, PR y los dos runs citados. El digest OCI y el preflight se registran como evidencia suministrada/reportada, no como inspección nueva del registro o VPS.

## Código publicado e integración

| Referencia | Estado al corte | Evidencia |
|---|---|---|
| `main` | `50c3d0f005683ef294d29cb6fab86fb4a8e134e1` | [Commit publicado](https://github.com/undercodeec/hermes_n8n/commit/50c3d0f005683ef294d29cb6fab86fb4a8e134e1) |
| Base piloto / checkout | `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0` | [Código](https://github.com/undercodeec/hermes_n8n/tree/ca85b991db1651f5bf500f3fb8e9db95ba9d56f0) |
| [PR #9](https://github.com/undercodeec/hermes_n8n/pull/9) | Integrado | `e861ea3e44ffeaebf86672cb14863dcb857ef5bb` |
| [PR #10](https://github.com/undercodeec/hermes_n8n/pull/10) | Integrado | `8c59c07735889f389e4b67b0450d9e71c313aa18` |
| [PR #13](https://github.com/undercodeec/hermes_n8n/pull/13) | Integrado | `88e9712fd6e16a730fcfd00acee10a25e84a429b` |
| [PR #15](https://github.com/undercodeec/hermes_n8n/pull/15) | Integrado | `49a7f6adf3776e81fae9675f66b12ad48271dcf3` |
| [PR #17](https://github.com/undercodeec/hermes_n8n/pull/17) | Integrado | `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0` |
| [PR #14](https://github.com/undercodeec/hermes_n8n/pull/14), [#16](https://github.com/undercodeec/hermes_n8n/pull/16), [#18](https://github.com/undercodeec/hermes_n8n/pull/18) | Abiertos | No tratar propuestas como integradas |
| [PR #19](https://github.com/undercodeec/hermes_n8n/pull/19) | Abierto, head `63bd52a2accfd9100cb4132b16c39ba94dff4bdd` | QA reportado: 114 suites / 1956 pruebas **locales**, no CI; no integrado |

La tabla destaca los hitos de esta reconciliación, no pretende enumerar todo el historial de merges.

## Imagen, CI y entorno servido

- [Publicación GHCR run 42426065900](https://github.com/undercodeec/hermes_n8n/actions/runs/42426065900): `success`, 2026-11-07 23:37:07 UTC, desde `main` en `50c3d0f005683ef294d29cb6fab86fb4a8e134e1`.
- Identidad OCI reportada: revision `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`; digest del **índice** `sha256:c94fcecc47ee381b7a76f9a4fd07d1d4ed2aacdf19c812b3fc128c143b40123d`. No incluye PR #19. Distinguir SHA del workflow, revisión OCI y digest; publicar imagen no prueba que esté desplegada.
- [Integration gate run 41230885213](https://github.com/undercodeec/hermes_n8n/actions/runs/41230885213): `failure` histórico del 31/10, SHA `ba23c67dd26c1c54a7b8941039f997095ee13029`. Es la única ejecución de ese gate identificada en la evidencia recibida; no se acredita CI verde del conjunto actual.
- Último preflight **reportado**: [documento remoto de PR #16 fijado a SHA](https://github.com/undercodeec/hermes_n8n/blob/5034fac19dcdbe49562a5b5cec068d3de0f9f60d/ProyectMD/HERMES_A7_BF17_PRODUCTION_PREFLIGHT_2026-11-07.md), corte 07/11 16:23 UTC, servido `88e9712`, **BLOCKED**. No está integrado ni existe localmente; no fue revalidado.
- **Producción actual desconocida.** No inferir del preflight anterior que el VPS sigue igual ni del GHCR posterior que se actualizó.

## Navegación y límites operativos

El [índice exhaustivo](../hermes-backend/docs/README.md) clasifica los 72 Markdown tracked del corte inicial y los nuevos destinos. [Runbook de despliegue](../hermes-backend/docs/deployment-runbook.md) y [runbook comercial](../hermes-backend/docs/commercial-black-friday-runbook.md) consolidan procedimientos; los informes conservan evidencia histórica y no autorizan ejecución automática.

STOP/opt-out, consentimiento, propiedad del handoff humano e idempotencia deben conservarse en cualquier cambio. Antes de habilitar operaciones, exigir regresiones controladas de baja/STOP sin respuesta comercial, handoff que impida respuesta automática, deduplicación de webhook y entrega ambigua sin reenvío ciego. Esta tarea documental no reejecuta ni certifica esas pruebas.

## Pendientes para el siguiente corte

1. Identificar runtime servido por SHA/digest, migraciones y flags efectivos sin secretos; adjuntar preflight nuevo y decisión explícita del operador.
2. Resolver los PR abiertos y sus gates sin trasladar QA local a CI ni anticipar integración de PR #19.
3. Contrastar identidad OCI directamente con el registro y conservar evidencia de provenance; verificar rollback y restauración en entorno controlado.
4. Revalidar contratos con frontend por su propia release; Hermes-web está fuera de este alcance.
5. Auditar funcionalmente runbooks temáticos e informes contra código actual. Inventariar y enlazar no equivale a verificar cada afirmación de los 72 documentos.
6. Mantener servicios/datos simulados para QA; ninguna activación productiva o envío real queda autorizado por esta reconciliación.
