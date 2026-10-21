# F3 retrieval canary — preparación local

Base: `66cd47722372f8252d0df49610b21403b6171d5f`. Estado: `BLOCKED_F3_RETRIEVAL_CANARY_QA_CONVERSATION_MISSING`; F3 sigue `OPEN`.

## Control de scope implementado

`LEARNING_RETRIEVAL_ENABLED=true` ya no basta para consultar learning. `AutoReplyService` comprueba `LEARNING_RETRIEVAL_CONVERSATION_ALLOWLIST` antes de llamar al selector. La allowlist acepta un solo identificador seguro y exacto; vacía, malformada, con espacios, wildcard, duplicados o varios IDs falla cerrada. Sólo la conversación coincidente puede consultar learning. Si el selector devuelve más de una pauta, este primer canary no inyecta ninguna. El control es independiente de `NOUS_HERMES_CONVERSATION_ALLOWLIST`, que decide el motor.

`ConfigModule` captura la configuración validada al iniciar. Cambiar el flag o la allowlist exige reiniciar de forma controlada todos los procesos que ejecutan turnos; el valor nuevo no afecta requests ya enviados. Los valores por defecto de `.env.example` conservan retrieval OFF y allowlist vacía. No se modificó `.env` productivo.

## Condiciones pendientes para live

Antes de acceder a VPS o activar retrieval se necesita una conversación QA/operator-owned previamente designada, con autorización explícita para su delivery; ID y versión de un único `LearningItem` humano aprobado, ACTIVE y elegible; y un operador responsable. Ninguno de esos datos fue proporcionado en el prompt o la sesión. No se debe escoger un cliente, lead o chat reciente como sustituto.

Con esos datos, el preflight deberá verificar lineage de release, rollback release, backup, salud de PostgreSQL/Redis/colas/contenedores, migraciones, espacio y flags efectivos. Deberá confirmar que sólo un item puede exponerse y que los cuatro flags empiezan OFF. El canary secuencial tendría como máximo un baseline y un turno ON por Gemini, luego por Nous, con rollback y reinicio después de cada ON; al final retrieval OFF y allowlist vacía. No hay autorización para rollout general.

## Evidencia de esta sesión

Las pruebas locales cubren flag OFF, allowlist vacía, QA exacta, no-QA, ID parecido, espacios, duplicados, wildcard, configuración ausente, concurrencia, ambos motores y más de un learning seleccionado. Pasaron 1300 pruebas unitarias y 101 pruebas de integración relevantes con PostgreSQL/Redis aislados, además de build, typecheck, lint, Prettier y Prisma validate. No hubo cambios de schema ni migraciones. El informe y los conteos constan en `artifacts/f3-retrieval-canary-gate/`. No se accedió a VPS ni se enviaron llamadas reales a providers, Meta o WhatsApp.

La corrida amplia de integración realizada en la base inmediata en el gate anterior encontró dos suites publicitarias ajenas a F3 detenidas en setup por falta de `ADS_D_TEST_DATABASE_URL` y `ADS_E_TEST_DATABASE_URL`. Se excluyeron de la corrida F3 relevante de esta preparación; no se afirma que hayan pasado.
