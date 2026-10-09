# Fase 0: evaluación de la salida final

Este harness local recorre los 24 casos sintéticos de `test/fixtures/conversation-engine.baseline.json` con `nous_hermes` y `gemini_direct` (48 ejecuciones). El recorrido usa la ruta de `WebhookService`, el guard de entrada, `AutoReplyService`, `CommercialPolicyService`, `CommercialSnapshot`, los revisores de afirmaciones comerciales, el guard de salida y la regla de elegibilidad de `AutomatedDeliveryService`. El texto evaluado es el lote preparado **después** de las correcciones finales; `delivery.syntheticIds` indica las partes que el fake habría confirmado. Una parte preparada puede quedar suprimida por la ventana de WhatsApp.

## Garantía de aislamiento

- El harness no crea `MetaService` ni `AutomatedDeliveryService` reales. La entrega es un fake en memoria y asigna identificadores `phase0.fake.*`.
- La dependencia Meta es un proxy sin token ni URL. Cualquier acceso a sus métodos registra `PHASE0_META_ACCESS_BLOCKED` y hace fallar el caso, incluso si el flujo absorbe la excepción.
- Prisma, campañas, tareas, leads, handoffs, cola y cuota Redis usan dobles locales. No se abre conexión a una base de datos ni a Redis. El número de soporte se sustituye por uno sintético.
- Learning queda desactivado en la configuración del harness.
- El modo offline usa respuestas deterministas y no construye clientes de proveedor. El modo provider sólo se inicia cuando `HERMES_PHASE0_PROVIDER_EVALUATION=true`; aun así, la entrega sigue siendo fake.

## Ejecución desde el checkout del backend

```bash
npm ci
npm run evaluate:phase0:offline -- --out phase0-offline.json
npm run evaluate:phase0:offline -- --case direct-price --engine nous_hermes --out phase0-one.json
npx jest src/scripts/phase0-evaluation-harness.spec.ts --runInBand
npm run build
npx eslint src/scripts/phase0-evaluation-harness.ts src/scripts/evaluate-phase0.ts src/scripts/phase0-evaluation-harness.spec.ts
npx prisma validate
```

`--out` crea un JSON en la ruta indicada. Sin `--out`, se imprime JSON en stdout. El proceso termina con código 1 si hay `FAIL_CRITICAL` o `ERROR_INFRA`; `FAIL_QUALITY` queda en el reporte y no rompe el gate de seguridad offline. `PASS` no reemplaza la revisión de calidad del proveedor: el doble offline no mide redacción, pertinencia ni consistencia conversacional real.

El fixture se mantiene en versión 1. Las extensiones opcionales son `commercialSnapshot`, `market`, `serviceCode`, `profile`, `contactName`, `inboundKind` y `deliveryWindow`; no se requieren datos productivos. `direct-price` incluye un importe **sintético** de USD 137.00 para probar autorización, mercado y moneda. `campaign-opt-out` usa un botón sintético y `closed-24h-window` simula un worker que responde más de 24 horas después del inbound.

## Modo provider con autorización posterior

Ejecutar únicamente cuando el operador autorice explícitamente llamadas a los modelos:

```bash
HERMES_PHASE0_PROVIDER_EVALUATION=true npm run evaluate:phase0:provider -- --out phase0-provider.json
```

Se pueden añadir `--case <id>` y `--engine nous_hermes|gemini_direct`. El motor Gemini usa `HermesService` y su configuración normal de `HERMES_API_URL`, `HERMES_API_KEY` y `HERMES_MODEL`. Nous usa `NousHermesTransport`, `AgentOutputValidator`, el endpoint privado fijado por el contrato y `NOUS_HERMES_API_KEY_FILE`. El harness llama directamente al transporte Nous para no levantar BullMQ/Redis; `AutoReplyService` sigue procesando el resultado por la misma política final. La bandera de autorización se comprueba **antes** de construir un cliente de proveedor. No editar `.env` para cambiar de motor.

El informe incluye caso, motor, modelo, hash del código de prompt/transporte, texto final, latencia, rechazos de propuestas, sustituciones, guards, errores, tokens cuando el proveedor los devuelve y entrega fake. No estima costos. Los controles semánticos basados en expresiones regulares son aproximaciones; revisar cada `FAIL_QUALITY` y las respuestas `PASS` antes de decidir sobre Fase 0.

## Procedimiento VPS

El commit de entrega es local y no se publica en `origin` desde esta tarea. El operador debe transferir el bundle Git local `phase0-final-output-harness.bundle` al VPS, por ejemplo a `/tmp/phase0-final-output-harness.bundle`. El bundle conserva el SHA del commit sin hacer push ni desplegar.

```bash
git fetch origin
git fetch /tmp/phase0-final-output-harness.bundle HEAD
git checkout <SHA_INFORMADO_EN_ENTREGA>
cd hermes-backend
npm ci
npm run evaluate:phase0:offline -- --out phase0-offline.json
```

Revisar `phase0-offline.json`, confirmar `fixtureCount=24`, `evaluated=48`, `delivery.metaCalls=0` en los 48 resultados y ausencia de `ERROR_INFRA`/`FAIL_CRITICAL`. Si existe autorización para evaluar modelos, ejecutar después el comando provider anterior y revisar `phase0-provider.json`. Para limpiar, borrar los JSON generados y el bundle transferido (`rm -f phase0-offline.json phase0-provider.json phase0-one.json /tmp/phase0-final-output-harness.bundle`). No hay contenedores ni tablas que desmontar. La Fase 0 permanece abierta hasta que el operador revise el reporte provider y sus hallazgos.
