# Recuperación del gate de integración — 31 de octubre de 2026

## Dictamen y alcance

**INTEGRATION_GATE_PASSED** en el entorno local aislado: se ejecutaron las 18 suites de `jest-integration.json`, con **188 pruebas aprobadas, cero fallidas y una omisión opcional preexistente**. El backend productivo no se modificó y no hubo envíos WhatsApp reales.

**READY_FOR_VPS_DEPLOY: NO.** El lint global del árbol candidato falla con 56 errores y 7 advertencias en seis archivos fuera de esta corrección; el mismo bloqueo aparece en el [workflow remoto de integración](https://github.com/undercodeec/hermes_n8n/actions/runs/41230885213). El lint de los archivos modificados sí pasó. Además, el PR de este harness debe integrarse y producir un nuevo digest GHCR antes del handoff para VPS. No se desactivó ni rebajó el lint global.

El incidente original en Codex VPS comunicó 5 suites aprobadas, 12 fallidas y 1 omitida (29/81/1 pruebas). El archivo `/root/evidence/hermes-nous-es-ec-20261031/integration.log` no está disponible en Codex Local. **No se puede atribuir con certeza cada una de aquellas 12 fallas a un nombre de suite a partir de ese resumen**. La tabla inferior documenta los requisitos de las 18 suites, los fallos reproducidos localmente y su resultado final, sin inventar la lista del VPS.

## Causa raíz y corrección

El comando genérico `npm run test:integration` entrega un mismo entorno a todas las suites, aunque sus guardas exigen bases y puertos diferentes. Algunas exigen la base `hermes_learning_test` en `55432` y Redis `56379`; otras exigen `55433`/`56380`, la base A3 en `55439`, la A6 en `55888`, bases `ads_d_test_*` y `ads_e_test_*`, o `retention_test`. Calendario se omite si falta `CALENDAR_TEST_DATABASE_URL`; al habilitarlo en Windows, su `spawnSync('psql')` falló porque el cliente no está instalado y el mensaje perdía `result.error`.

El nuevo `run-integration-gate.mjs` comprueba primero que los seis puertos de loopback estén libres, levanta cuatro PostgreSQL y dos Redis desechables mediante un proyecto Compose exclusivo, crea tres bases auxiliares y aplica las migraciones a las siete bases. Luego ejecuta **cada suite exactamente una vez** con su URL compatible, registra su resultado y elimina contenedores y volúmenes incluso tras una falla. Rechaza una suite sin pruebas aprobadas y cualquier omisión adicional. Solo permite la omisión existente del BFF web de Fase H cuando no hay `ADS_H_WEB_ROOT` ni una compilación Next preparada; ninguna suite se omite.

Calendario usa `psql` del contenedor únicamente con el modo explícito `docker-integration-gate`, el proyecto efímero esperado y la URL exacta `127.0.0.1:55432/hermes_learning_test`. Conserva el modo anterior de `psql` local. La suite crea dos esquemas temporales, aplica migraciones con `ON_ERROR_STOP` y `search_path`, verifica la actualización con fixtures y elimina los esquemas al finalizar; sus siete casos pasaron. Su error ahora incluye el fallo del proceso hijo si el ejecutable no existe.

Publicidad tenía una segunda causa reproducida: el fixture enviaba `phone_number_id` vacío mientras `WebhookService` requiere el ID configurado. Se añadió el mismo ID **sintético** al webhook y a su `ConfigService`; el guardia productivo no cambió. En la primera corrida del harness, Calendario falló 7/7 y Publicidad D 4/4. Las otras 16 suites pasaron (177 aprobadas, 11 fallidas, una omitida). Después de corregir ambos fixtures, las 18 suites pasaron.

## Resultado por suite

Las categorías son las del encargo: **A** URL incompatible, **B** puerto o base, **C** usuario/credenciales, **D** fixture o migración, **E** esquema temporal, **G** requisito de entorno distinto. Indican el requisito que debe atender el harness; no afirman que la suite estuviera entre las 12 fallidas del VPS sin su log.

| Suite (`test/*.integration-spec.ts`) | Requisito y categoría | Resultado local final |
| --- | --- | --- |
| `automated-delivery` | Base principal migrada, 55432 (B) | 7/7 |
| `calendar-meetings` | URL de calendario, `psql`, permisos y esquemas temporales (D/E/G); fallo local reproducido | 7/7 |
| `commercial-solution` | `DATABASE_INTEGRATION_URL` principal (A/B) | 5/5 |
| `conversation-guard-cold-start` | Redis 56379 (B) | 7/7 |
| `conversation-learning` | Base principal 55432 y Redis 56379 (A/B) | 43/43 |
| `f3-approval` | Base principal 55432 (A/B) | 29/29 |
| `f3-rollback` | Base principal 55432 y Redis 56379 (A/B) | 1/1 |
| `f3-single-generation` | Base principal 55432 y Redis 56379 (A/B) | 28/28 |
| `f3-traceability` | Base principal 55432 (A/B) | 1/1 |
| `inbound-turn` | Base principal y Redis aislados (A/B) | 7/7 |
| `nous-hermes-queue` | Redis aislado (B) | 3/3 |
| `nous-recovery-pagination` | URL exacta y credenciales sintéticas de 55432, Redis 56379 (A/B/C) | 9/9 |
| `advertising-flow` | Base `ads_d_test_gate`, ID telefónico sintético (B/D); fallo local reproducido | 4/4; 1 caso BFF web omitido |
| `advertising-outbox` | Base `ads_e_test_gate` y Redis aislado (B/D) | 6/6 |
| `f3-native-diagnostics` | Base A3, usuario `a3_gate`, puerto 55439 (A/B/C) | 5/5 |
| `f3-canary-run-scope` | Base A6 en 55888 (A/B) | 21/21 |
| `a7-d16-critical` | URL exacta de A7 en 55433 y Redis 56380 (A/B/C) | 3/3 |
| `retention-policy` | `retention_test` en 55433; sin URL se omite por guarda existente (B) | 2/2 |

## Validaciones y aislamiento

| Control | Resultado |
| --- | --- |
| Integración general por grupos compatibles | 18/18 suites; 188 aprobadas, 0 fallidas, 1 omisión opcional; resumen local `hermes-backend/artifacts/integration-gate-20261031/summary.json`. |
| Unitarias completas | 104/104 suites; 1694/1694 pruebas. |
| Comerciales ES/EUR y EC/USD | 3/3 suites; 229/229 pruebas. |
| A7–D16 independiente | 6/6 suites; 31/31 pruebas; resumen local `hermes-backend/artifacts/integration-gate-recovery/summary.json`. |
| Build NestJS, `prisma validate` con URL ficticia | Aprobados. |
| `security:secrets` con archivos versionados nuevos | Aprobado, 542 archivos examinados. |
| ESLint de los dos archivos TS modificados; Prettier de archivos nuevos/modificados; diff check | Aprobados. |
| Lint global | Falló por 56 errores preexistentes en `campaigns.media-security.spec.ts`, `gate-d-gemini-log.spec.ts`, `hermes-diagnostics.ts`, `leads.service.spec.ts`, `tasks.service.spec.ts` y `tasks.service.ts`. No pertenecen a este cambio. |

Compose publica únicamente en `127.0.0.1:55432`, `55433`, `55439`, `55888`, `56379` y `56380`. El runner comprueba ocupación antes de levantar servicios, elimina del entorno hijo credenciales y variables Meta/Google/Nous heredadas, usa credenciales sintéticas fijas y destruye los volúmenes de su proyecto al terminar. Se verificó que esos puertos y contenedores quedaron libres tras las corridas. Ni `PriceList` productiva ni las protecciones STOP, handoff, opt-out, atribución o seguridad cambiaron.

## Procedencia y publicación pendiente

- Commit candidato previo: `4eff536094c619e8a5818e707d7193f940ba86c4`; Tree `4f53663b0e26023c2ea4b42735b6a44f71ce4063`.
- Commit de corrección del harness: `e9389975fe5820fb1ac1903c3d560e10a16a0419`; Tree `86c47649226ef8a485e8b86ec4ed0d602abf6d3b`.
- Digest GHCR anterior: `ghcr.io/undercodeec/hermes-backend@sha256:283bd5b99cdcdffea2506e85c4cc208eafa3cce570201569734f57dd2582c0ec`. **No representa el árbol corregido**.
- PR y HEAD/Tree definitivos: pendientes de integrar el cambio versionado. Digest GHCR nuevo: pendiente del workflow oficial tras la integración autorizada.

Para continuar: revisar el PR de este harness, resolver el lint global sin reducir el control, integrar conforme a las protecciones del repositorio y la autorización del propietario, repetir el gate en el commit integrado, ejecutar el workflow manual GHCR y registrar el digest nuevo. Solo entonces preparar el handoff a Codex VPS. **No se realizó despliegue desde Codex Local.**
