# HERMES A7-D16-R2 — cierre de validaciones críticas

Fecha local: 2026-10-27. **Dictamen: `PILOT_CRITICAL_TESTS_PASSED`.** Las tres pruebas críticas con interrupción y reinicio de procesos pasaron en el arnés local, junto con la regresión seleccionada. Este dictamen prepara la revisión de un piloto pequeño y supervisado; no equivale a `E2E_VALIDATED` para toda la matriz avanzada ni autoriza por sí solo activar o desplegar el piloto.

## Alcance y entorno

- Worktree: `D:\Documentos\Hermes\.worktrees\a7-d16-nous-e2e`; rama `validation/a7-d16-nous-e2e`; base `c722b36754272f96a25591555417eb44a80807ce`.
- Se extendió el arnés R1 existente. No se reconstruyó: `docker-compose.a7-d16-e2e.yml`, `scripts/run-a7-d16-e2e.mjs`, la guarda de egreso, el Jest específico y el workflow manual siguen siendo la base.
- Windows 11 y Docker Desktop; PostgreSQL `16-alpine` y Redis `7-alpine` temporales, expuestos solo en `127.0.0.1:55433` y `127.0.0.1:56380`. Base `hermes_a7_d16_test`, 26 migraciones terminadas y `PONG` de Redis. El runner ejecutó `docker compose down --volumes --remove-orphans` en `finally`; la comprobación posterior no encontró contenedores ni volumen A7-D16.
- Fixtures sintéticos y nombres de cola únicos. Nous y Meta se sustituyeron por respuestas de prueba; contadores en Redis registraron sus invocaciones. El runner elimina variables heredadas de credenciales y fija las URL de PostgreSQL/Redis de prueba. La guarda de egreso bloquea destinos Node fuera de loopback tanto en Jest como en los procesos hijos. No se hicieron llamadas a proveedores reales. Esta guarda no es un cortafuegos de todo el host.
- No se tocó VPS, PostgreSQL productivo, `main`, rama piloto, flags DARK, F3/F4, aprendizaje ni despliegue. No se creó ni publicó ningún commit.

## Pruebas nuevas y evidencia de reinicio

Se añadieron `test/a7-d16-critical.integration-spec.ts` y `test/a7-d16-critical-worker.cjs`; el runner R1 incluye la suite y guarda `artifacts/a7-d16-e2e/critical.json`. Cada caso usa un proceso hijo real, `SIGKILL`, un PID nuevo para la recuperación, Prisma/PostgreSQL y BullMQ/Redis reales. El tiempo de antigüedad o expiración se adelanta en los registros sintéticos para no esperar 15 minutos de reloj; la lógica de recuperación ejecutada es la real.

| Escenario | Interrupción y reinicio observados | Evidencia PostgreSQL/Redis | Resultado |
| --- | --- | --- | --- |
| Resultado Nous durable antes de completar BullMQ | Worker PID 19356 detenido después de `storeNousResult` y antes de completar el job; recuperador PID 29324 | `nousResultAt` y texto persistidos mientras el job seguía `active`; al reiniciar, turno `PROCESSING` → `PROCESSED`; contador Nous **1**, Meta **1**; ledger **1 `CONFIRMED`**, outbound **1** | La recuperación reutilizó el resultado; cero inferencias, respuestas o entregas duplicadas. |
| Entrega Meta incierta | Proceso PID 32764 detenido después de iniciar la llamada simulada y dejar ledger `DISPATCHING`; recuperador PID 29520 tras vencer el claim | `recoverExpiredClaims` cambió ledger a `AMBIGUOUS` con `CLAIM_EXPIRED`; `wamid` nulo, outbound **0**, contador Meta **1**; tarea `PENDING_REVIEW` **1** antes de repetir `recoverBatch` | Dos consultas de recuperación posteriores no reenviaron ni crearon tareas adicionales; cero confirmaciones falsas. |
| Admisión entre `markNousQueued` y `queue.add` | Proceso PID 10968 detenido tras guardar el marcador y antes de añadir el job; recuperador PID 23012 | PostgreSQL tenía `nousQueuedAt`, Redis no tenía el job; tras el escaneo: turno `BLOCKED`, razón `NOUS_QUEUE_OUTCOME_UNKNOWN_REVIEWED`, contador Nous **0**, tarea humana **1** | No se reencoló una solicitud incierta ni se ejecutó otra inferencia. |

Los PID y contadores proceden de la última ejecución local (`critical.json`). El estado de BullMQ y la ausencia de job se consultaron en Redis; los resultados, ledger, mensajes y tareas se consultaron en PostgreSQL. Los contadores Redis permitieron detectar duplicaciones; **no se detectaron** en estos tres escenarios.

## Corrección funcional necesaria

La primera ejecución de la prueba de Meta descubrió un fallo: el ledger llegaba a `AMBIGUOUS` sin reenvío ni confirmación falsa, pero no había una tarea de revisión humana. Se modificaron únicamente `src/automated-deliveries/automated-delivery.module.ts` y `src/automated-deliveries/automated-delivery.service.ts` para inyectar `TasksService` y solicitar una revisión con código `NOUS_META_DELIVERY_AMBIGUOUS` cuando una respuesta Nous queda ambigua. La solicitud ocurre tanto después de una entrega terminal como al recuperar claims vencidos, sin esperar a que otra ruta consulte el lote. Se limita a `HERMES_REPLY` cuya metadata declara `conversationEngine: nous_hermes`; otros tipos de entrega conservan su comportamiento. `TasksService.requestHermesReview` serializa por conversación y deduplica la fuente; la prueba repite la recuperación y comprueba una sola tarea. Primero fallaron las aserciones que exponían cada hueco; después pasaron las tres pruebas y la regresión. Esta es la única modificación funcional de R2 y responde directamente al requisito de revisión humana.

## Auditoría de dependencias

Se ejecutaron `npm audit --json` y `npm audit --omit=dev --json`, sin `npm audit fix` ni cambios en `package.json` o `package-lock.json` por la auditoría. Los JSON se guardaron en `artifacts/a7-d16-e2e/`. El primer comando informó **10 paquetes afectados: 8 bajos, 1 moderado, 1 crítico**. El segundo informó **0** en dependencias de producción. Todos los hallazgos del primero pertenecen al árbol de desarrollo:

| Paquete instalado | Gravedad | Relación en el proyecto |
| --- | --- | --- |
| `@jest/core` 30.4.2 | Baja | Transitiva de desarrollo |
| `@nestjs/cli` 11.0.23 | Baja | Directa de desarrollo |
| `deepmerge` 4.3.1 | Baja | Transitiva de desarrollo |
| `fast-uri` 3.1.8 | Moderada | Transitiva de desarrollo |
| `fork-ts-checker-webpack-plugin` 9.1.0 | Baja | Transitiva de desarrollo |
| `handlebars` 4.7.9 | **Crítica** | Transitiva de desarrollo |
| `jest` 30.4.2 | Baja | Directa de desarrollo |
| `jest-cli` 30.4.2 | Baja | Transitiva de desarrollo |
| `jest-config` 30.4.2 | Baja | Transitiva de desarrollo |
| `ts-jest` 29.4.11 | Baja | Directa de desarrollo |

`npm explain handlebars` establece la ruta `devDependency ts-jest@29.4.11 → handlebars@4.7.9`. Los avisos [GHSA-8r5x-fm3f-whwj](https://github.com/advisories/GHSA-8r5x-fm3f-whwj) y [GHSA-p8wg-vrv2-v86f](https://github.com/advisories/GHSA-p8wg-vrv2-v86f) describen las condiciones de explotación y señalan **4.7.10** como versión corregida. El primero requiere que un objeto AST no confiable llegue a `compile`/`precompile`; el segundo requiere una plantilla controlada por un atacante con configuración permisiva de métodos de prototipo. El backend no importa Handlebars directamente. Su Dockerfile instala dependencias de desarrollo en la etapa de compilación, pero la etapa final ejecuta `npm ci --omit=dev` y copia `dist` y Prisma, no el árbol completo del builder. Por la ruta de dependencia, la auditoría de producción vacía y el Dockerfile, **no se identificó una vía de explotación de ese paquete en el runtime desplegado**. Es una inferencia sobre el proyecto y el Dockerfile, no una verificación de una imagen productiva construida. El paquete sí queda presente en entornos de desarrollo y CI que instalan el árbol completo.

Recomendación separada: actualizar el lockfile para resolver Handlebars a 4.7.10 o posterior compatible, revisar el resultado de `npm audit` y repetir las pruebas antes de integrar la corrección. La actualización altera el árbol transitivo y puede romper tooling de pruebas o compilación; `npm audit fix` automático también puede proponer cambios mayores en otras cadenas y no corresponde a esta validación. El hallazgo crítico **no se clasifica como bloqueo de seguridad del runtime del piloto** con la evidencia actual; sí requiere seguimiento para el entorno de desarrollo/CI y nueva evaluación si cambia la imagen o el uso de plantillas.

## Regresión y workflow manual

| Comprobación | Resultado local final |
| --- | --- |
| `npm run test:a7-d16:e2e` | **6 suites, 31/31 pruebas**; 28,202 ms incluyendo infraestructura, migraciones, pruebas y limpieza. Incluye flujo E2E R1 y suites de integración de cola, recuperación, turnos y entregas. |
| `npm test -- --runInBand` | **94 suites, 1529/1529 pruebas**; Jest 20.871 s. |
| `npm run build` | Correcto; 7.5 s de ejecución de comando. |
| `git diff --check` | Sin errores de espacios. `package-lock.json` sin cambios. |

El workflow `.github/workflows/a7-d16-nous-e2e.yml` solo tiene `workflow_dispatch`, permisos `contents: read`, `actions/checkout@v4` con `ref: ${{ github.sha }}` para el commit seleccionado, Node 22, `npm ci --ignore-scripts`, ejecución del arnés y carga de `artifacts/a7-d16-e2e/` incluso si falla. No contiene pasos de despliegue ni referencias a secretos productivos. La limpieza de contenedores, red y volumen se realiza en el `finally` del runner. **No se publicó ni ejecutó remotamente**; por tanto, el resultado del runner GitHub y la retención efectiva de artefactos están pendientes.

Para poder lanzarlo remotamente, primero debe existir el archivo del workflow en la rama predeterminada: GitHub lo exige para `workflow_dispatch` ([sintaxis de workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [ejecución manual](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow?tool=webui)). Después de una revisión y autorización separadas, publicar el workflow en la rama predeterminada, publicar el commit de validación elegido, seleccionar explícitamente esa rama/commit al ejecutar manualmente (por ejemplo, `gh workflow run a7-d16-nous-e2e.yml --ref validation/a7-d16-nous-e2e`) y comprobar SHA, JSON subidos, resumen y limpieza en el runner. Este procedimiento es documentación; no se realizó ninguno de esos pasos.

## Riesgos pendientes y recomendación de piloto

- La matriz avanzada de todos los puntos de interrupción y el recorrido completo de 101 solicitudes reales a los mocks Nous→PostgreSQL→Meta siguen fuera de este cierre. La prueba de capacidad R1 ejercita 101 jobs BullMQ sintéticos, no ese recorrido completo.
- La prueba de Meta simula la incertidumbre deteniendo el proceso después de iniciar la llamada. No puede saber si Meta externo aceptó una petición real; justamente por eso el ledger queda `AMBIGUOUS` y exige revisión humana sin reenvío automático.
- Si la base falla entre marcar un claim vencido como `AMBIGUOUS` y crear su tarea, el estado seguro persiste, pero la tarea podría requerir una nueva invocación de `recoverBatch` o intervención operativa. La recuperación repetida fue comprobada cuando las dependencias están disponibles.
- La guarda de egreso del arnés y los mocks no sustituyen una validación de red del runner remoto ni pruebas contra proveedores reales. La ejecución en GitHub Actions está pendiente.
- Los hallazgos de desarrollo, especialmente Handlebars, deben corregirse y verificarse por separado antes de ampliar o institucionalizar CI.

Recomendación: presentar este resultado para **preparar**, con revisión humana y controles operativos existentes, un piloto pequeño y supervisado. Toda activación, publicación del workflow, cambio de flags o despliegue requiere una decisión posterior. No se declara `E2E_VALIDATED` para la matriz avanzada.
