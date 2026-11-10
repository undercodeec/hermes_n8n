# HERMES 2.0 — saneamiento TypeScript y revisión de dependencias

> **Acta histórica.** Resultados originales conservados; no acredita seguridad ni CI actual. [Estado vigente](estado-proyecto.md).

Fecha: 2026-11-04. Entorno: Windows, Node 24.12.0 existente, Docker Desktop, bases y Redis desechables en loopback. No se tocó producción, no se desplegó ni se fusionó ningún PR.

## Referencias y comparación reproducible

Cada referencia se comprobó en un checkout aislado con `npm ci --ignore-scripts`, su propio cliente generado con `prisma generate` y `npx tsc --noEmit --pretty false --incremental false`. Los registros conservan archivo, línea, columna, código, mensaje y código de salida.

| Referencia | HEAD remoto verificado | Lockfile SHA-256 | `tsc` original | Con saneamiento aplicado en rama temporal |
| --- | --- | --- | ---: | ---: |
| Piloto `pilot/a7-d12-monitor-only-20261026` | `fb36afe2f62952ebb99848851ea8c862cc98ce79` | `04FF01ADB2A790CB0100F58E672B178581AFCEDD617598328F1434E49237DF55` | salida 2, 146 | salida 0, 0 |
| PR #9 `fix/nous-personalized-formal-salutation-20261103` | `41b9365f90d120ee4de98d3707898122d682e1df` | `CCD4BA5C0A68289FEB9BEC53F540CA2531F38824DAF273CA117A0AAC5CBA0818` | salida 2, 146 | salida 0, 0 |
| PR #10 `feat/hermes-commercial-packages-20261104` | `23113d2588180f3d727d45f430bec430a370873e` | `CCD4BA5C0A68289FEB9BEC53F540CA2531F38824DAF273CA117A0AAC5CBA0818` | salida 2, 146 | salida 0, 0 |

Los 146 pares `(archivo, código TS)` son idénticos en las tres referencias. El piloto remoto es ancestro de PR #9. Por tanto, los 146 diagnósticos son preexistentes al PR #9 y al PR #10. Distribución: TS2345 91, TS2554 22, TS2322 19, TS2339 6, TS2532 2 y uno de cada TS2740, TS7022, TS7024, TS2741, TS2353, TS2344. Afectan 29 archivos de pruebas. El commit independiente `e54e683df587addfc38585e4b13c6d5e6cb94132` repara el piloto. Los cherry-picks de verificación `a25fd5c`/`a1ea053` se aplicaron sin conflictos a ramas temporales desde PR #9/#10; `cc7b619`/`1d6db98` agregaron también el parche de dependencia. Las ramas originales no se cambiaron.

## Causas, corrección y riesgo

| Grupo | Errores | Archivos representativos | Causa y corrección mínima | Riesgo de regresión |
| --- | ---: | --- | --- | --- |
| `HermesRequestDto` y aprendizaje aprobado | 80 | `hermes.service.spec.ts`, `f3-native-gemini.spec.ts`, `scoped-provider-attempts.spec.ts`, `gate-d-gemini-log.spec.ts` | Solicitudes sintéticas sin `contactName` obligatorio; pauta sin `kind`, `trigger` y `guidance`. Se completaron fixtures con valores sintéticos válidos. | Bajo: solo datos de prueba; unitarias y F3 integradas aprobadas. |
| Constructores de pruebas | 22 | `webhook.service.spec.ts`, `auto-reply.service.spec.ts`, `advertising-flow.integration-spec.ts` | Dobles de `AutomatedDeliveryService` y `PaymentsService` ausentes tras crecer las firmas. Se añadieron en la posición contractual. | Bajo: sin cambios en constructores productivos; integración aprobada. |
| Interfaces comerciales | 12 | `commercial-authority.ad-campaign.spec.ts`, `commercial-black-friday.spec.ts`, `commercial-policy.service.spec.ts` | Literal de versión de política ensanchado a `string`, mercado de fixture demasiado estrecho y decisión sin `requiresComplaintHandoff`. Se tiparon constantes y fixture completos. | Bajo: ninguna tarifa, promoción ni política productiva cambió. |
| Mocks de Prisma y datos persistidos | 8 | `automated-delivery.service.spec.ts`, `campaigns.service.spec.ts`, `meeting-operations.service.spec.ts`, `review-canary.spec.ts`, `automated-delivery.integration-spec.ts` | Inferencia circular, métodos omitidos, retornos no anulables y `contactId` perdido dentro de callback. Se declararon contratos reales de los dobles y se fijó el identificador local. | Bajo: pruebas de persistencia aprobadas. |
| Contratos externos Axios/Redis | 3 | `gate-d-gemini-log.spec.ts`, `conversation-learning.integration-spec.ts` | Axios exige `InternalAxiosRequestConfig` con cabeceras; BullMQ e ioredis traen copias de tipos incompatibles. Se creó configuración Axios válida y se pasó a BullMQ una configuración de conexión explícita, preservando host, puerto, usuario, contraseña y DB. | Bajo: integración Redis y trazas de log aprobadas. |
| Literales y enums de fixtures | 9 | `advertising*`, `handoff`, `leads`, `learning`, `retention` | TypeScript infería un único valor literal y las pruebas luego mutaban el estado. Se declararon los enums permitidos. | Bajo: escenarios de transición siguen verificándose. |
| Otros contratos de pruebas | 12 | `auto-reply`, `canary-run`, `agent-output`, `conversation-events`, `payments`, `price-lists-access` | Tipos de mocks y callback, campos opcionales, firma de Nest HTTP y acceso a estado. Se precisaron tipos y expectativas sin suprimir diagnósticos. | Bajo: unitarias completas aprobadas. |

Total: **146**. Se modificaron 30 archivos de pruebas (24 en `src/`, 6 en `test/`), incluidos los seis grupos anteriores y `test/nous-hermes-queue.integration-spec.ts` para comprobar liberación de listeners. No hay cambios en código productivo, `tsconfig`, snapshots ni alcance de suites. No se añadieron `@ts-ignore`, `@ts-nocheck` ni `any` como solución.

## Validación posterior

| Checkout | TypeScript | Build | Unitarias | ESLint | Prisma | Secretos | Integración aislada | A7-D16 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Piloto + `e54e683` | 0 errores | pasa | 105 suites, 1.748/1.748 | pasa | pasa con URL sintética | pasa | 18 suites, 188 pasan, 1 omisión autorizada | 6 suites, 31/31 |
| PR #9 + ambos commits, rama temporal `cc7b619` | 0 errores | pasa | 106 suites, 1.777/1.777 | pasa | pasa | pasa | 18 suites, 188 pasan, 1 omisión autorizada | 6 suites, 31/31 |
| PR #10 + ambos commits, rama temporal `1d6db98` | 0 errores | pasa | 112 suites, 1.855/1.855 | pasa | pasa | pasa | 18 suites, 188 pasan, 1 omisión autorizada | 6 suites, 31/31 |
| Parche de dependencia `ff4f667` sobre piloto | 146 errores del baseline sin saneamiento | pasa | 105 suites, 1.748/1.748 | pasa | pasa | pasa | 18 suites, 188 pasan, 1 omisión autorizada | 6 suites, 31/31 |

El intento inicial de ejecutar las 18 integraciones con una sola URL falló porque cinco suites exigen bases y puertos diferentes. Se repitió con `node scripts/run-integration-gate.mjs`, que crea cada base desechable y asigna las URLs esperadas; esa ejecución es la que figura como aprobada. El caso omitido es la intención BFF web v2, expresamente autorizada por `integration-gate-config.mjs`.

Se repitió también el fixture comercial de PR #10 sobre un PostgreSQL desechable, retirando su `@ts-nocheck` local: **9/9** pruebas aprobadas. Comprueba nueve planes con doce meses, Black Friday USD 80, hasta dos planes turísticos, cotización contextual, mercados y saludos. Las 1.855 unitarias y las integraciones confirman STOP, opt-out, privacidad, F3, deduplicación y handoff. El fixture fue solo evidencia local y no forma parte de los commits.

## Auditoría npm

`npm audit --json` sobre el lock de PR #10: **23** paquetes (2 bajos, 18 moderados, 2 altos, 1 crítico). `npm audit --omit=dev --json`: solo `axios` y `follow-redirects`, ambos altos; `axios` hereda el aviso del paquete transitivo. El lock fuerza `follow-redirects@1.16.1` mediante `overrides`. El [aviso GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p) confirma rango afectado 1.16.0–1.16.1 y arreglo en 1.16.2. El ataque requiere `sensitiveHeaders` construido en otro realm y una redirección entre orígenes; la búsqueda del código no encontró uso de `sensitiveHeaders`, así que no hay evidencia de explotación en los flujos actuales. La dependencia sí ejecuta tráfico HTTP productivo y por eso se preparó `ff4f667d547c135c98dd92350772422c057313be` en una rama separada: solo `package.json` y seis líneas del lock. Tras `npm ci`, `npm audit --omit=dev` reporta **0** alertas y `npm audit` completo reporta **21** (2 bajas, 18 moderadas, 1 crítica). No se usó `npm audit fix` ni se actualizó una versión mayor.

La tabla registra cada paquete señalado. “Sí” en arreglo significa que npm ofrece un cambio compatible; “mayor” exige revisión de compatibilidad. Los avisos indirectos se heredan del paquete indicado en la columna de causa. Ninguna de las 21 alertas restantes entra en `--omit=dev`; su riesgo se concentra en herramientas locales o CI. `handlebars` llega solo por `ts-jest`. No se hallaron llamadas de la aplicación a `Handlebars.compile`/`precompile` con AST no confiable ni renderizado de plantillas controladas con `allowProtoMethodsByDefault: true`, condiciones de los dos [avisos críticos](https://github.com/advisories/GHSA-8r5x-fm3f-whwj) [de Handlebars](https://github.com/advisories/GHSA-p8wg-vrv2-v86f). El [tercer aviso](https://github.com/advisories/GHSA-xw65-4hp5-5hc7) requiere insertar en HTML inline la salida precompilada de una plantilla no confiable.

| Paquete | Instalado | Ruta introductora / aviso | Sev. | Ámbito | Arreglo npm | Aplicabilidad observada |
| --- | --- | --- | --- | --- | --- | --- |
| `axios` | 1.20.0 | directo → `follow-redirects` | Alta | Producción | Sí, transitorio | Cliente HTTP; depende del vector de redirección descrito. |
| `follow-redirects` | 1.16.1 | `axios`; GHSA-mrwp-f3q8-3g9p | Alta | Producción | 1.16.2 | No se halló `sensitiveHeaders` entre realms; parche preparado. |
| `handlebars` | 4.7.9 | `ts-jest`; GHSA-xw65-4hp5-5hc7, GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f | Crítica | Desarrollo | Sí | Sin uso de Handlebars desde la aplicación; condiciones específicas descritas arriba. |
| `deepmerge` | 4.3.1 | `@nestjs/cli` → `fork-ts-checker-webpack-plugin` y Jest; GHSA-gcqx-w48m-w2h4 | Baja | Desarrollo | Mayor | Herramientas de build/test. |
| `fork-ts-checker-webpack-plugin` | 9.1.0 | `@nestjs/cli` → `deepmerge` | Baja | Desarrollo | Mayor | Build local/CI. |
| `fast-uri` | 3.1.8 | `@nestjs/cli` → AJV; GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp | Moderada | Desarrollo | Sí | Validación de esquemas de tooling. |
| `glob` | 13.0.6, 10.5.0 | `@nestjs/cli` y Jest; GHSA-3g3m-2fjr-6pw4, `minimatch` | Moderada | Desarrollo | Mayor | Patrones internos de herramientas. |
| `minimatch` | 10.2.5, 9.0.9 | `glob` y `@typescript-eslint/typescript-estree`; GHSA-g3hv-75wg-m249 | Moderada | Desarrollo | Mayor | Patrones de build, test y lint. |
| `@nestjs/cli` | 11.0.23 | directo → `glob`, `fork-ts-checker-webpack-plugin` | Moderada | Desarrollo | Mayor (12) | Solo CLI. |
| `jest` | 30.4.2 | directo → `@jest/core`, `jest-cli` | Moderada | Desarrollo | Mayor/downgrade propuesto | Solo runner de pruebas. |
| `@jest/core` | 30.4.2 | `jest` → `jest-config`, `jest-runner`, `jest-runtime`, `@jest/reporters` | Moderada | Desarrollo | Mayor/downgrade | Solo pruebas. |
| `@jest/reporters` | 30.4.1 | `@jest/core` → `glob` | Moderada | Desarrollo | Mayor/downgrade | Solo reportes. |
| `jest-circus` | 30.4.2 | `jest-config` → `jest-runtime` | Moderada | Desarrollo | Mayor/downgrade | Solo pruebas. |
| `jest-cli` | 30.4.2 | `jest` → `@jest/core`, `jest-config` | Moderada | Desarrollo | Mayor/downgrade | Solo CLI de pruebas. |
| `jest-config` | 30.4.2 | `jest-cli` → `glob`, `deepmerge`, runner | Moderada | Desarrollo | Sí, según npm | Solo configuración de pruebas. |
| `jest-runner` | 30.4.2 | `jest-config` → `jest-runtime` | Moderada | Desarrollo | Mayor/downgrade | Solo pruebas. |
| `jest-runtime` | 30.4.2 | `jest-runner`/`jest-circus` → `glob` | Moderada | Desarrollo | Mayor/downgrade | Solo pruebas. |
| `typescript-eslint` | 8.62.0 | directo → familia `@typescript-eslint` | Moderada | Desarrollo | Sí | Solo lint. |
| `@typescript-eslint/eslint-plugin` | 8.62.0 | `typescript-eslint` → parser, utils, estree | Moderada | Desarrollo | Sí | Solo lint. |
| `@typescript-eslint/parser` | 8.62.0 | `typescript-eslint` → estree | Moderada | Desarrollo | Sí | Solo lint. |
| `@typescript-eslint/type-utils` | 8.62.0 | plugin → estree, utils | Moderada | Desarrollo | Sí | Solo lint. |
| `@typescript-eslint/typescript-estree` | 8.62.0 | parser, utils → `minimatch` | Moderada | Desarrollo | Sí | Solo lint. |
| `@typescript-eslint/utils` | 8.62.0 | familia TypeScript ESLint → estree | Moderada | Desarrollo | Sí | Solo lint. |

Los avisos directos de `fast-uri`, `glob` y `minimatch`, sus rangos y propuestas de arreglo están íntegros en `npm-audit-full.json`. Las propuestas de downgrade de Jest o de major de Nest CLI no se aplicaron: requieren un PR propio y pruebas de compatibilidad. La severidad agregada no demuestra por sí sola que una entrada del proyecto alcance el vector vulnerable.

## `MaxListenersExceededWarning`

Se reprodujo en el piloto con `NODE_OPTIONS=--trace-warnings`. La pila identifica `test/nous-hermes-queue.integration-spec.ts:67–69`: el test inicia 101 `Job.waitUntilFinished` en `Promise.all` con concurrencia global de uno. BullMQ 5 añade un listener `closing` temporal por espera en `job.js:897` y lo elimina al completar o fallar. El test ahora comprueba `queue.listenerCount('closing') === 0` después de los 101 trabajos; integración 188/188 y A7-D16 31/31 pasan. La advertencia representa exceso temporal de esperas concurrentes en la prueba, **sin fuga demostrada**. En producción podrían coincidir más de diez esperas sobre una cola y producir la misma advertencia; no se ha observado allí. No se elevó el límite de listeners ni se alteró la cola productiva. Si aparece con tráfico real, medir esperas activas y listeners después de su cierre.

## Estrategia Git, riesgos y dictamen

1. Revisar y fusionar el [PR #11](https://github.com/undercodeec/hermes_n8n/pull/11), rama independiente `fix/hermes-typescript-baseline-20261104`, hacia el piloto. Mantener `e54e683` separado de los cambios de saludos y paquetes.
2. Revisar el [PR #12](https://github.com/undercodeec/hermes_n8n/pull/12), rama independiente `fix/hermes-follow-redirects-20261104`, hacia el piloto. `ff4f667` corrige solo la dependencia productiva; no mezclar con lógica comercial.
3. Integrar ambos commits por merge normal, sin rebase destructivo ni force push, en las ramas de PR #9 y PR #10 según sus dependencias; los cherry-picks temporales prueban que aplican sin conflictos. Repetir gates sobre los HEAD finales y las nueve pruebas comerciales de PR #10 antes de fusionar o desplegar.

**HERMES_TYPESCRIPT_GATE_PASSED** para el piloto saneado y para las combinaciones temporales de PR #9/#10, con todos los gates técnicos y funcionales requeridos aprobados. **HERMES_TYPESCRIPT_GATE_BLOCKED** para los HEAD originales de PR #9/#10 hasta integrar el saneamiento. **HERMES_SECURITY_REVIEW_REQUIRED** porque los HEAD originales aún fijan `follow-redirects@1.16.1` y quedan 21 alertas de desarrollo por revisar. Las ramas temporales con ambos commits dejan cero alertas productivas; la rama separada de seguridad también pasó build, 1.748 unitarias, 188 integradas, 31 A7-D16, ESLint, Prisma y secretos. **No desplegar todavía**.

Evidencia local: `D:\Documentos\Hermes\.worktrees\hermes-commercial-packages-20261104\hermes-backend\artifacts\typescript-security-remediation\`. SHA-256: `pilot-tsc-baseline.txt` `4C4162683C0B9BA2A197E72C75D28D5A68FBF656C6B9FC609657D31CC2D84D79`; `pr9-tsc-baseline.txt` `0181A0A4A12E289F25C981C6958F93D95B6C18C1A2A9B9D7961A55920A7D71A2`; `pr10-tsc-baseline.txt` `E37C81D463523A9F8092B55BCEE03AEFF68C9F68569694277CBF09F71A241678`; `npm-audit-full.json` `4AC7BB6AC3D83FDD35303539B6AFD9B6FF8472E3616074A527BEA21B9D791898`; `npm-audit-prod.json` `12FEA130F2CDF46461918DBD6854384CAD8A40A64A710C68E608224D9C8A4A8E`; `security-audit-prod.json` `C3D74629D7490B3B248C3858D19FF5E510645A245AF611E22DDC819DA6CB8A66`. Los logs de unitarias, integración y A7-D16 están en el mismo directorio.
