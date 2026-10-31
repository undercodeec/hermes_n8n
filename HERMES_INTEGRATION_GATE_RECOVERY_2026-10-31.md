# HERMES 2.0 — recuperación del gate de integración (2026-10-31)

**Dictamen: INTEGRATION_ENVIRONMENT_BLOCKED.** La imagen candidata no se desplegó. El runner A7-D16 prohíbe expresamente este VPS productivo y falta su ejecución en GitHub Actions o Windows local. El lint completo también falla por errores preexistentes; no se oculta ese resultado. No corresponde declarar `READY_FOR_VPS_DEPLOY`.

## Base y causa raíz de las 12 suites fallidas

Base: commit `4eff536094c619e8a5818e707d7193f940ba86c4`, tree `4f53663b0e26023c2ea4b42735b6a44f71ce4063`. Log original: `/root/evidence/hermes-nous-es-ec-20261031/integration.log`, 12 suites y 81 pruebas fallidas. El launcher anterior inyectó la misma URL PostgreSQL y Redis, con puertos aleatorios, en suites que exigen destinos distintos. Sus guardas hicieron lo correcto al rechazarla.

| Suite originalmente fallida | Categoría | Causa raíz comprobada | Resultado aislado |
| --- | --- | --- | --- |
| `conversation-learning` | A, B | Exige `hermes_learning_test` en 55432 y Redis 56379. | PASS, grupo learning |
| `f3-single-generation` | A, B | Exige base learning en 55432/55888 y Redis 56379. | PASS, grupo learning |
| `f3-approval` | B | Exige base learning y puerto 55432. | PASS, grupo learning |
| `advertising-flow` | B, D | Exige `ADS_D_TEST_DATABASE_URL` con nombre `ads_d_test_*`; tras proveerla, el fixture carecía del teléfono sintético requerido por el guarda WhatsApp. | PASS, 4 casos; 1 omisión BFF preexistente |
| `f3-canary-run-scope` | B | Exige `hermes_a6_d1_temp` en 55888. | PASS, 21 casos |
| `advertising-outbox` | B | Exige `ADS_E_TEST_DATABASE_URL` con nombre `ads_[de]_test_*`; Redis de prueba dedicado para sus casos de cola. | PASS, 6 casos |
| `calendar-meetings` | E, G | `psql` no existe en el host; `spawnSync` devolvió error de arranque y la suite lo imprimía como `undefined`. | PASS, grupo learning |
| `a7-d16-critical` | B, C | Exige URL exacta del usuario `a7_d16_test`, base `hermes_a7_d16_test` en 55433 y Redis 56380. | PENDIENTE: runner prohibido en este VPS |
| `f3-rollback` | B | Exige base learning en 55432 y Redis 56379. | PASS, grupo learning |
| `nous-recovery-pagination` | B, C | Solo acepta URL y credenciales learning o A7 exactas, con Redis 56379/56380. | PASS, grupo learning |
| `f3-native-diagnostics` | B, C | Exige usuario `a3_gate`, base `hermes_a3_temp` y puerto 55439. | PASS, 5 casos |
| `f3-traceability` | B | Exige base learning en 55432. | PASS, grupo learning |

Las cinco suites aprobadas en el intento original fueron `automated-delivery`, `inbound-turn`, `nous-hermes-queue`, `conversation-guard-cold-start` y `commercial-solution`. `retention-policy` fue omitida originalmente por falta de `RETENTION_TEST_DATABASE_URL`; ahora se ejecutó y aprobó. No se identificó un defecto productivo en las fallas originales. La categoría F no aplica a esas 12 suites.

## Corrección y aislamiento

`scripts/run-all-integration.py` comprueba que los seis puertos estén libres antes de iniciar un proyecto Docker Compose de nombre aleatorio. El Compose temporal usa PostgreSQL 16 y Redis 7 con bindings exclusivos `127.0.0.1`. Migra tres bases independientes, clona la base de pruebas migrada para A6, Ads D/E y retención, y ejecuta las suites por grupos compatibles. El proceso de Jest recibe un entorno mínimo con credenciales sintéticas; no hereda claves de Meta, WhatsApp, IA o producción. Siempre ejecuta `docker compose down --volumes`, incluso tras una falla. El modo completo se niega a correr en `racknerd-8cc858a` y en rutas productivas.

El cliente de calendario `scripts/calendar-test-psql.py` verifica host, puerto, usuario, base y el ID del contenedor que creó el Compose antes de ejecutar `psql` dentro de ese contenedor. El usuario de prueba pudo crear dos esquemas `calendar_*`, aplicar las 27 migraciones y el camino de actualización con `search_path` propio. Las siete pruebas de calendario pasaron; el `afterAll` elimina ambos esquemas y el Compose elimina el contenedor y sus volúmenes. El mensaje de fallo ahora incluye el error de arranque de `psql` si vuelve a faltar. Ads D usa un `phone_number_id` sintético coincidente con `META_PHONE_NUMBER_ID`; el guarda estricto de producción permanece intacto.

No se tocaron `PriceList`, tarifas de España, la promoción USD 80 de Ecuador, controles STOP, handoff, opt-out, atribución ni mecanismos de seguridad. No se realizó envío WhatsApp real ni conexión a los contenedores productivos `hermes-postgres`/`hermes-redis` (5432/6379). Los puertos de prueba observados estaban libres antes de iniciar y no quedaron contenedores temporales activos tras la ejecución.

## Validación observada

| Control | Resultado |
| --- | --- |
| Unitarias completas | 104 suites, 1694/1694 pruebas, PASS |
| Integración general permitida en VPS | 17 suites, 185 aprobadas, 0 fallidas, 1 omitida preexistente |
| A7-D16 general y runner oficial | PENDIENTE en entorno autorizado |
| Comercial ES/EUR y EC/USD | 27/27 casos comerciales específicos, PASS |
| Build | PASS |
| Prisma validate | PASS |
| `security:secrets` | PASS, 517 archivos revisados tras retirar artefactos temporales |
| Lint de los TS modificados | PASS |
| Lint completo | FAIL: 62 errores y 7 avisos en seis archivos preexistentes y, antes de formatear, el fixture Ads D. El fixture modificado ya pasó lint dirigido. |
| `git diff --check` | PASS |

La única omisión restante es el caso Ads H BFF de `advertising-flow`, condicionado desde antes a `ADS_H_WEB_ROOT` y a un build Next actual. El checkout del backend no incluye ese build. Ninguna suite originalmente fallida se omitió para producir estos resultados; A7-D16 figura expresamente como pendiente y el gate completo no se declara aprobado. Evidencia local: `integration-recovery-run3.log`, `unit-recovery.log`, `commercial-recovery.log`, `build-recovery.log`, `prisma-validate-recovery.log`, `security-secrets-recovery.log`, `lint-recovery.log`, `lint-directed-recovery.log` en `/root/evidence/hermes-nous-es-ec-20261031/`.

## Archivos y release

Archivos modificados: `.github/workflows/integration-gate.yml`, `hermes-backend/docker-compose.integration-test.yml`, `hermes-backend/scripts/run-all-integration.py`, `hermes-backend/scripts/calendar-test-psql.py`, `hermes-backend/package.json`, `hermes-backend/test/advertising-flow.integration-spec.ts`, `hermes-backend/test/calendar-meetings.integration-spec.ts` y este informe. Los cambios versionados alteran el tree, por lo que el digest GHCR original `sha256:283bd5b99cdcdffea2506e85c4cc208eafa3cce570201569734f57dd2582c0ec` solo identifica la base y **no** es el digest de este árbol. Commit y tree finales: pendientes del PR y de los gates. Digest nuevo: pendiente del workflow oficial GHCR tras integración autorizada.

Condiciones pendientes: ejecutar `npm run test:integration:all` y `npm run test:a7-d16:e2e` en GitHub Actions o Windows local, resolver o justificar de forma aprobada el lint completo, revisar el PR y sus protecciones, integrar solo con autorización del propietario, publicar GHCR desde el HEAD definitivo y entregar sus SHA y digest a Codex VPS. No desplegar desde este entorno.
