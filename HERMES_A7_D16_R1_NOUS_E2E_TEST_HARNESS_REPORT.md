# HERMES A7-D16-R1 — informe del arnés E2E aislado

Fecha local: 2026-10-27. **Dictamen: `E2E_HARNESS_READY`.** El recorrido sintético principal y las suites integradas seleccionadas pasaron localmente. No corresponde `E2E_VALIDATED` para todos los puntos de interrupción: algunos solo cuentan con pruebas unitarias de fallos simulados y faltan pruebas de caída real del proceso en esos límites.

## Entorno y rama

- Sistema: Windows 11 Pro, Docker Desktop con motor Linux disponible; al inicio había aproximadamente 17 GB de RAM libre y 134 GB libres en D:.
- Worktree: `D:\Documentos\Hermes\.worktrees\a7-d16-nous-e2e`.
- Rama: `validation/a7-d16-nous-e2e`, creada desde el commit exacto `c722b36754272f96a25591555417eb44a80807ce`.
- El worktree piloto `pilot/a7-d12-monitor-only-20261026` permaneció limpio. No se usó la VPS, no se desplegó, no se activó Nous comercial y no se publicó ningún commit ni workflow.

## Archivos

| Tipo | Archivos |
| --- | --- |
| Creados | `.github/workflows/a7-d16-nous-e2e.yml`; `hermes-backend/docker-compose.a7-d16-e2e.yml`; `hermes-backend/scripts/run-a7-d16-e2e.mjs`; `hermes-backend/test/jest-a7-d16.json`; `hermes-backend/test/a7-d16-egress-guard.cjs`; `hermes-backend/test/a7-d16-nous.e2e-spec.ts`; este informe. |
| Evidencia creada | `hermes-backend/artifacts/a7-d16-e2e/{jest-results,summary,infrastructure,capacity}.json`. |
| Modificados | `.gitignore` (permite versionar este informe); `hermes-backend/package.json` (comando del arnés); `hermes-backend/test/nous-hermes-queue.integration-spec.ts` (101 trabajos y métricas); `hermes-backend/test/nous-recovery-pagination.integration-spec.ts` (acepta la nueva base exacta); `hermes-backend/src/conversation-engine/nous-hermes.transport.spec.ts` (incluye solicitud 80). |

No se modificó código funcional de producción ni el workflow de publicación GHCR.

## Infraestructura y aislamiento

El compose A7-D16 crea PostgreSQL `16-alpine`, Redis `7-alpine`, red y volumen exclusivos. Expone únicamente `127.0.0.1:55433` y `127.0.0.1:56380`; usa la base sintética `hermes_a7_d16_test` y credenciales de prueba. El ejecutor fija las URL exactas, elimina variables heredadas que puedan contener claves o direcciones de proveedores, genera Prisma, aplica las **26 migraciones**, ejecuta Jest y destruye contenedores, red y volumen incluso cuando una fase falla. La sonda registró 26 migraciones finalizadas y `PONG` de Redis; al terminar, `docker compose ps` y la búsqueda del volumen A7-D16 no mostraron recursos restantes.

La URL Nous del código es fija (`http://nous-hermes-api:8642/v1/chat/completions`). La prueba intercepta `axios.post`, comprueba esa URL y devuelve una respuesta sintética; Meta también es simulado. Una guarda cargada antes de cada suite bloquea conexiones Node a hosts distintos de loopback, y una prueba confirma el bloqueo. Esta guarda es una barrera del proceso Jest, no un cortafuegos del sistema operativo; las conexiones nativas de Prisma quedan acotadas por la URL exacta de la base de prueba.

## Cobertura y resultados

Comando local: `cd hermes-backend; npm run test:a7-d16:e2e`. Resultado final: **5 suites, 28 pruebas aprobadas, 0 fallidas, 0 omitidas**, 18,071 ms incluyendo arranque, migración y destrucción. `npm run build`: aprobado. `npm test -- --runInBand`: **94 suites, 1529 pruebas aprobadas, 0 fallidas**. `git diff --check` y comprobación sintáctica del ejecutor: sin errores. El YAML del workflow se analizó correctamente. Estas cifras proceden de la ejecución local, no de GitHub Actions.

| Área | Evidencia local |
| --- | --- |
| Flujo principal | Una entrada sintética crea y reclama un turno; el motor reserva Nous, BullMQ invoca una vez al procesador y al agente simulado, PostgreSQL guarda el resultado antes de finalizar el job, el servicio de entrega prepara una sola operación y Meta simulado confirma una sola vez. La reprogramación del mismo inbound y la preparación/entrega repetidas no duplicaron turno ni envío. |
| Antes de cola | La suite de turnos recupera un turno persistido cuyo job original no se añadió. |
| Cola, espera y reinicio | La suite Nous recupera 20 resultados tras reiniciar el worker; también conserva el job original tras una espera acotada y una interrupción más larga. |
| Resultado durable y señal BullMQ | La prueba principal comprueba el resultado en PostgreSQL. Las pruebas unitarias existentes comprueban pérdida de notificación, clave de finalización ausente y rechazo de completar sin escritura durable. |
| Paginación y ambigüedad | La suite PostgreSQL/Redis prueba páginas de 99, 100, 101 y 250 turnos, un job desaparecido, empates de fecha, reinicio del recuperador, error de consulta y resultado que llega durante la reconciliación. El job desaparecido termina bloqueado para revisión humana, sin nuevo despacho. |
| Entrega | La suite PostgreSQL prueba claim atómico, clave única, supresión por inbound más reciente, recuperación de trazas, rollback de preparación y supresión posterior a inferencia. Las pruebas unitarias existentes cubren claim vencido y respuesta Meta ambigua. |
| `MONITOR_ONLY` | La suite unitaria del transporte ejercita solicitudes 44, 80, 100 y 101; comprueba estimación y alertas. La prueba principal configura límites comerciales inferiores al consumo de una solicitud y aun así obtiene el resultado en modo monitor. Las pruebas unitarias existentes comprueban parada administrativa e idempotencia. |

Capacidad: **101 jobs sintéticos**, dos workers BullMQ, concurrencia global configurada en 1 y máxima observada de 1; 1587 ms para el lote, **63,64 jobs/s**, latencia de finalización p50 **810 ms**, p95 **1497 ms**, máximo **1574 ms**. Cada job simula 3 ms de trabajo; estas cifras caracterizan la cola local y no son capacidad ni latencia del recorrido completo con Nous y Meta.

## Brechas y problemas detectados

1. No existe todavía una prueba de caída real del proceso en cada límite solicitado: después de la reserva, después de inferencia, entre persistencia y notificación BullMQ, después de separar la espera y durante una entrega Meta incierta. Esos comportamientos tienen cobertura combinada de integración y unidad, pero no una única matriz E2E de fallos con reinicios de proceso y PostgreSQL/Redis reales.
2. Las solicitudes 44/80/101 usan un contador simulado en la prueba unitaria. No se ejecutaron 101 invocaciones completas Nous→PostgreSQL→Meta. La prueba de carga de 101 jobs usa un procesador BullMQ sintético.
3. La guarda de egreso protege el proceso Node/Jest; no demuestra aislamiento de red a nivel de host ni de procesos hijos. El workflow CI no se ha publicado ni ejecutado remotamente.
4. `npm ci` informó 10 hallazgos de auditoría de dependencias (8 bajos, 1 moderado, 1 crítico). No se cambiaron dependencias en esta intervención; requieren evaluación independiente antes de adoptar el workflow.

No se observó un fallo funcional del código del CRM en las pruebas ejecutadas. Para cerrar la validación total hacen falta puntos de inyección de fallos o un supervisor de procesos de prueba que permita detener y reanudar workers en los límites anteriores, más pruebas E2E de entrega ambigua. No se propone cambiar flags DARK ni comportamiento de producción con esta evidencia.

## Workflow propuesto y condiciones de uso

`.github/workflows/a7-d16-nous-e2e.yml` solo admite `workflow_dispatch`. Usa `github.sha` para obtener el commit exacto elegido, instala Node 22 y dependencias con `npm ci`, ejecuta el arnés con PostgreSQL/Redis temporales, aplica migraciones, publica resumen en `GITHUB_STEP_SUMMARY`, sube los JSON como artefacto y destruye la infraestructura en `finally`. No contiene despliegue ni secretos de producción.

Antes de publicar o ejecutar CI: revisar la rama y este informe; revisar la política de egreso y los hallazgos de dependencias; escoger explícitamente el commit de validación; ejecutar manualmente en un runner GitHub con Docker; comparar artefactos y ausencia de recursos restantes. Para emitir `E2E_VALIDATED`, completar las pruebas de caída y reanudación enumeradas arriba y obtener evidencia de su ejecución.
