# F3 retrieval rollback — procedimiento conceptual

Base offline: `83364e8d1175a05077d8e4b970fe2872bcdd6467`. Gate: `F3_ROLLBACK_GATE = PROVEN_OFFLINE`. F3 sigue `OPEN`; el canary de retrieval está pendiente.

## Frontera real

`AutoReplyService.processTurn` lee `LEARNING_RETRIEVAL_ENABLED` una vez por turno, justo antes de llamar a `LearningRetrievalService.select`. Sólo el valor exacto `true` activa la selección. OFF omite el selector y construye el request al mismo motor sin `approvedLearning`. `LEARNING_SHADOW_ENABLED` se lee por separado y puede producir telemetría shadow aun con retrieval OFF. `LEARNING_REVIEW_ENABLED` se lee en el servicio reviewer; `LEARNING_SUMMARY_ENABLED` no tiene lector runtime en este corte (sólo scripts/tests).

`AppModule` usa `ConfigModule.forRoot({ validate })`; la configuración validada tiene prioridad sobre `process.env` y queda capturada al iniciar el proceso. Cambiar `.env` o el entorno de un proceso en ejecución no cambia ese valor. **RESTART_REQUIRED = YES**, para todos los procesos que procesan turnos de chat. La frontera efectiva es el primer turno nuevo procesado por un proceso reiniciado que haya leído OFF. Un turno que ya leyó ON puede completar el selector y el request; una petición enviada al proveedor no se reescribe retroactivamente. Una entrega ya `PREPARED` conserva el ledger y su exposición histórica.

## Desactivación de emergencia futura

1. Fijar `LEARNING_RETRIEVAL_ENABLED=false` en la configuración prevista de la release, manteniendo el motor elegido y los otros flags según su propia decisión operativa.
2. Reiniciar de forma controlada todos los procesos que ejecutan `AutoReplyService`; verificar que el nuevo proceso lee `false`. Evitar nuevos turnos en procesos anteriores durante el relevo.
3. Verificar con turnos nuevos que el selector no se invoca, el request del motor omite `approvedLearning`, la metadata nueva omite `learningExposed`, el motor y la ruta comercial responden normalmente, y los datos/historial conservan sus hashes y estados.

No se ejecutó este procedimiento en producción. No requiere `RETIRE`, borrar `LearningItem`, `LearningEvidence`, reviews, auditorías o deliveries, revertir migraciones, restaurar la base ni vaciar Redis. Retrieval usa PostgreSQL directamente y no tiene caché Redis propia. Shadow puede seguir su contrato independiente. Las aprobaciones y retiros existentes no cambian por OFF.

## Evidencia local

`artifacts/f3-rollback-gate/offline-rollback-report.json` contiene la secuencia OFF→ON→OFF→ON por Gemini Direct y Nous, los hashes de requests normalizados, datos y trazas, la matriz sintética de 30 casos, medidas descriptivas y los conteos de pruebas. El harness usa únicamente PostgreSQL/Redis locales aislados y proveedores falsos; llamadas externas reales: 0.
