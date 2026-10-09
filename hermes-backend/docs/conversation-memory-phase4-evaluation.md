# Evaluación de memoria larga de Hermes (Fase 4)

Estado: preparación local. No existen resultados de proveedor real ni del recorrido completo del backend para este corpus. `LEARNING_SUMMARY_ENABLED` permanece apagado; no hay escritor automático de `ConversationState.summary` en esta fase.

## Corpus y pares

`test/fixtures/conversation-memory.phase4.json` contiene cuatro casos inventados: un dato temprano que queda fuera de la ventana de 20 mensajes, una necesidad corregida, aislamiento de otro contacto y un precio sin fuente autorizada. `interveningMessages` genera turnos de relleno sintéticos para demostrar que el primer hecho deja de estar en esa ventana. `summaryCandidate` es una propuesta manual de contexto para la variante `summary`, nunca un resumen producido por Hermes ni prueba de que el modelo lo usaría correctamente.

Para medir calidad hay que producir, por cada caso y cada motor evaluado, dos respuestas **finales tras las políticas del backend** con el mismo modelo, versión de prompt e instantánea comercial. `baseline` usa el contexto actual; `summary` agrega solamente el resumen sintético del mismo caso. El harness que produzca esas respuestas debe simular la entrega sin enviar a Meta, y guardar resultados fuera de Git. `src/scripts/benchmark-hermes.ts` llama directamente al proveedor y no produce este contrato de salida final.

El archivo de resultados debe ser un array JSON. Cada objeto tiene estos campos:

```json
{
  "caseId": "long-early-code",
  "engine": "nous_hermes",
  "variant": "baseline",
  "finalReply": "Respuesta final después de políticas",
  "providerModel": "modelo observado",
  "promptVersion": "versión observada",
  "snapshotVersion": "instantánea autorizada observada",
  "policyApplied": true,
  "deliverySimulated": true,
  "latencyMs": 120,
  "costEstimateUsd": null,
  "executedActions": [],
  "observedCommercialOutcome": null
}
```

Repetir con `variant: "summary"` para el mismo caso. Completar los cuatro pares por motor; no mezclar versiones dentro de un par. `policyApplied` y `deliverySimulated` son declaraciones del harness externo, no verificaciones del evaluador. Un costo desconocido se representa con `null`, nunca con cero. El resultado comercial observado se registra aparte y no aumenta la puntuación de respuesta.

Ejecutar desde `hermes-backend`:

```bash
npm run evaluate:learning-phase4 -- /ruta/privada/resultados-phase4.json
```

El reporte de consola incluye sólo IDs de casos con regresión y conteos, p95, costo agregado cuando esté disponible, acciones ejecutadas y presencia de resultados comerciales; no imprime respuestas. `CANDIDATE_FOR_HUMAN_REVIEW` exige pares de ambos motores, al menos una mejora por motor y cero regresiones críticas; aun así `activation` sigue `BLOCKED`. Un solo motor devuelve `INCOMPLETE_ENGINE_COVERAGE`. La rúbrica automática usa términos literales sintéticos y es deliberadamente acotada. Una revisión humana ciega debe evaluar naturalidad, utilidad y posible contaminación antes de decidir si hace falta un resumidor. Se necesitan además capacidad, costo, privacidad, retención y los pendientes de Fase 2.
