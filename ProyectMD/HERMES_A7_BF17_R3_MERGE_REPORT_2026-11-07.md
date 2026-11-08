# Hermes 2.0 — A7-BF17-R3: integración controlada del PR #17

**Dictamen:** `HERMES_A7_BF17_R3_MERGED_VALIDATED`
**Fecha:** 2026-11-07
**Repositorio:** `undercodeec/hermes_n8n`
**Destino:** `pilot/a7-d12-monitor-only-20261026`

## Autorización y preflight

El propietario autorizó expresamente la operación `MERGE_PR17_TO_PILOT` para el [PR #17](https://github.com/undercodeec/hermes_n8n/pull/17), HEAD `880acdcc50f41a129693a103a71d8ad4cd673a48`, base `49a7f6adf3776e81fae9675f66b12ad48271dcf3` y destino piloto indicado arriba. La autorización no abarca GHCR, despliegue ni intervención en datos productivos.

Antes de escribir en GitHub se volvió a comprobar directamente que el PR estaba abierto, sin fusionar, fusionable y en borrador; que tenía dos commits y exactamente diez archivos; y que el tree candidato era `0f1b57434021587dd46347f03629ac9bac82122f`. Se leyó el patch completo de los diez archivos. La comparación confirmó que el HEAD estaba dos commits por delante de la base autorizada, sin divergencia de la base. No había reviews, hilos, estados de commit, check runs ni ejecuciones de Actions vinculadas al HEAD. Por ello, los gates locales se registran como evidencia independiente, no como CI de GitHub.

La API de la rama destino informó `protected=false`, checks obligatorios vacíos y enforcement desactivado; la lista de rulesets del repositorio estaba vacía. El endpoint administrativo de protección devolvió 403 para esta conexión, así que esa lectura adicional no estuvo disponible. No se utilizó bypass.

## Integración realizada

Tras quitar el estado de borrador y repetir la identidad del HEAD y de la base, GitHub efectuó un **merge commit** con comprobación del HEAD esperado. El PR figura `merged=true` y cerrado.

| Referencia | SHA |
| --- | --- |
| Base piloto anterior, primer padre | `49a7f6adf3776e81fae9675f66b12ad48271dcf3` |
| HEAD revisado del PR, segundo padre | `880acdcc50f41a129693a103a71d8ad4cd673a48` |
| [Merge commit integrado](https://github.com/undercodeec/hermes_n8n/commit/ca85b991db1651f5bf500f3fb8e9db95ba9d56f0) | `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0` |
| Tree definitivo | `0f1b57434021587dd46347f03629ac9bac82122f` |

La rama piloto en GitHub apunta al merge commit y su tree coincide exactamente con el candidato aprobado. No se modificó `main` ni se fusionó otro PR.

### Diez archivos integrados

1. `ProyectMD/HERMES_A7_BF17_R2_WEBHOOK_INBOX_FIX_2026-11-07.md`
2. `hermes-backend/src/campaigns/phone-normalizer.spec.ts`
3. `hermes-backend/src/campaigns/phone-normalizer.ts`
4. `hermes-backend/src/payments/payments.service.spec.ts`
5. `hermes-backend/src/payments/payments.service.ts`
6. `hermes-backend/src/webhook/webhook-inbox-recovery.spec.ts`
7. `hermes-backend/src/webhook/webhook-inbox-validation.ts`
8. `hermes-backend/src/webhook/webhook.service.spec.ts`
9. `hermes-backend/src/webhook/webhook.service.ts`
10. `hermes-backend/test/advertising-flow.integration-spec.ts`

No se integraron migraciones ni cambios de Docker Compose, `current.json` o reglas de Black Friday.

## Validación posterior sobre el merge commit

Se creó un worktree aislado, detached, en `ca85b991db1651f5bf500f3fb8e9db95ba9d56f0`. Las dependencias se instalaron con `npm ci --ignore-scripts --no-audit --no-fund` y se generó el cliente Prisma. PostgreSQL y Redis de las pruebas se levantaron en contenedores desechables con puertos sólo en loopback. No hubo llamadas Meta reales.

| Gate | Resultado |
| --- | --- |
| TypeScript `tsc --noEmit` y build NestJS | PASS |
| ESLint completo y Prettier completo | PASS |
| Prisma validate con URL sintética local | PASS |
| Escaneo de secretos | PASS; 550 archivos examinados en el worktree limpio |
| `npm audit --omit=dev --audit-level=high` | PASS; 0 vulnerabilidades reportadas |
| Unitarias completas | 113 suites, 1.949 PASS, 0 FAIL |
| Focalizadas de normalizador, inbox, webhook y pagos | 4 suites, 97 PASS, 0 FAIL |
| Comerciales seleccionadas, Black Friday y entregas | 3 suites, 297 PASS, 0 FAIL |
| Integración aislada | 18 suites, 192 PASS, 0 FAIL, 1 skip previsto del BFF web v2 |
| A7-D16 E2E aislado | 6 suites, 31 PASS, 0 FAIL |

Las pruebas del Inbox cubren cuarentena permanente con `leaseUntil=NULL`, ausencia de reintentos infinitos incluso con lease alterado, reintentos transitorios con backoff y claim, outcomes históricos `processing_error`/`attribution_retry`, un fixture legado con más de 5.000 intentos, reentrega corregida conservada como `REDELIVERY_CONFLICT` y ninguna liberación automática. También cubren idempotencia tras fallos entre contacto, conversación, mensaje, atribución, comprobante, preparación y entrega simulada, además de mensajes y estados Meta válidos e inválidos.

La rama piloto mantiene las pruebas de Black Friday: selección comercial desde CRM, USD 80, diez prestaciones, soporte conforme al alcance, saludo, dos entregas físicas cuando corresponden, STOP, handoff y ledger de entregas. El diff de este PR no toca esa funcionalidad.

## Riesgos y estado productivo

Una reentrega con el mismo identificador y contenido distinto queda disponible para cotejo humano, sin procesarse automáticamente. Una llamada Meta de resultado ambiguo también exige conciliación antes de cualquier nuevo envío. La procedencia del payload del incidente original continúa sin establecerse. Estos límites impiden inferir un remitente o duplicar una entrega externa.

Esta operación no verificó ni modificó la VPS. Según el contexto autorizado, producción continúa en una versión anterior; el merge piloto no corrige por sí solo el evento productivo. Siguen pendientes, en operaciones separadas:

1. Backup reciente y restauración aislada.
2. Reconciliación de `current.json` y sus 23 archivos Compose.
3. Evaluación del incidente de exposición de credenciales.
4. Recuperación o cuarentena efectiva del evento productivo, con autorización propia.
5. Publicación de una imagen GHCR nueva.
6. Preflight productivo actualizado.
7. Autorización independiente del despliegue.

Las operaciones comerciales A/B permanecen separadas. No se desplegó, reinició, migró, envió WhatsApp, alteró PostgreSQL/Redis ni publicó una imagen.

## Handoff para una futura publicación GHCR

El workflow manual [`.github/workflows/hermes-backend-ghcr-manual.yml`](https://github.com/undercodeec/hermes_n8n/blob/main/.github/workflows/hermes-backend-ghcr-manual.yml) reside en `main` y exige despacharse desde `main`, tomando el código del HEAD piloto aprobado. Para la próxima operación, previa autorización y nuevo cotejo de la rama, los parámetros son:

```text
source_sha=ca85b991db1651f5bf500f3fb8e9db95ba9d56f0
expected_tree=0f1b57434021587dd46347f03629ac9bac82122f
```

No se ejecutó el workflow ni se publicó GHCR. El SHA anterior `49a7f6adf3776e81fae9675f66b12ad48271dcf3` no contiene la corrección del Inbox y no debe usarse como fuente de esa imagen.
