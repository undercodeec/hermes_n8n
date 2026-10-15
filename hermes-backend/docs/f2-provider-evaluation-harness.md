# F2 provider evaluation: corpus y harness offline

Contrato del reviewer: backend `721f9756e658bc553ea0238b836fb236f8ae850b`. Rúbrica humana: `ae4cfa23567f4745fd990df3dd853e97749b65d6`, `docs/f2-human-review-synthetic-2026-10-13.md`. Este harness no cierra `F2_PROVIDER_EVALUATION_GATE` ni activa learning.

## Corpus congelado

`test/fixtures/f2-provider-evaluation.v1.json` contiene exactamente A, B1, B2, C, D, E y F. Son mensajes inventados para esta evaluación; B1 y B2 tienen mensajes, IDs locales y temas distintos. `test/fixtures/f2-provider-evaluation.v1.sha256.json` congela el SHA-256 de `JSON.stringify` del cuerpo de solicitud que construye el mismo módulo usado por `ReviewModelService`. El hash no incluye hora ni credenciales. Cualquier cambio de fixture, saneamiento, prompt, schema o modelo invalida el manifest y detiene la ejecución.

## Modo normal: offline

Desde `hermes-backend`, ejecutar `npm run evaluate:f2-provider`. No necesita `DATABASE_URL`, Redis ni key. Instala una barrera sobre `http.request`, `https.request`, `net.connect` y `fetch` antes de preparar las solicitudes. Produce `artifacts/f2-provider-evaluation/dry-run.json` con siete cuerpos finales, hashes y presupuesto: 7 entradas × 2 repeticiones = 14 llamadas planificadas, 0 llamadas realizadas. Ese directorio está ignorado por Git.

El script importa el cliente del reviewer, el saneamiento y el constructor de solicitudes; no importa `LearningModule`, Prisma, BullMQ, workers, Meta, WhatsApp ni Nous. No hay conexión a BD ni escritura de `ConversationReview`, `LearningItem` o `LearningEvidence`. El harness también compara las claves de la respuesta con el `json_schema` solicitado: si el parser actual aceptase un candidato sin `serviceCode`/`market`, lo registra como violación crítica `F2_SCHEMA_ACCEPTED_OUTSIDE_REQUEST` y detiene nuevas llamadas, sin cambiar el parser productivo.

## Modo real, reservado a otra sesión

El modo real requiere **ambos** argumentos `--execute-real --acknowledge-budget=14`, worktree limpio, `LEARNING_REVIEW_MODEL=gemini-3.8-flash`, `HERMES_API_URL` HTTPS y `HERMES_API_KEY` disponible en el entorno seguro. También exige cuatro flags learning en false o ausentes y allowlist vacía. No usa `HERMES_MODEL` como fallback. **No ejecutar en la sesión de preparación.** La ruta real llama `ReviewModelService.review` secuencialmente, una vez por repetición, sin retry. Un timeout, 429, HTTP error o JSON/schema inválido consume su plaza. Tras 14 intentos no hay llamada 15. Una violación crítica detiene las solicitudes posteriores.

Antes de la primera llamada se crea en exclusiva `artifacts/f2-provider-evaluation/real-call-ledger.json`. Cada intento se reserva y sincroniza allí **antes** de contactar al proveedor. Si el proceso cae, el ledger permanece y un nuevo arranque se niega a repetir llamadas automáticamente. El resultado futuro se guarda localmente como `artifacts/f2-provider-evaluation/real-run-<epoch>.json`, con commit, modelo, hashes, solicitudes intentadas, resultados por caso, latencias, uso cuando esté disponible y errores. `costUsd` queda `N/D`; no existe tarifa canónica verificada. p50/p95 y recursos locales serán descriptivos, sin umbral de aprobación automático. El output se sanea antes de persistirse. El validador automático es conservador y no sustituye la revisión humana de contexto semántico, sobre todo en C y E.

La [plantilla de revisión humana](f2-provider-evaluation-human-review-template.md) espera salidas reales nuevas y no precarga un juicio del operador. Ningún candidato se aprueba ni se persiste por esta evaluación. El gate permanece abierto hasta revisar el acta real y decidir sus umbrales ausentes.
