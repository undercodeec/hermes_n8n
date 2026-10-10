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
npm run build
npm run evaluate:phase0:offline -- --out phase0-offline.json
npm run evaluate:phase0:offline -- --case direct-price --engine nous_hermes --out phase0-one.json
npx jest src/scripts/phase0-evaluation-harness.spec.ts src/scripts/evaluate-phase0.spec.ts --runInBand
npx eslint src/scripts/phase0-evaluation-harness.ts src/scripts/evaluate-phase0.ts src/scripts/phase0-report-writer.ts src/scripts/phase0-evaluation-harness.spec.ts src/scripts/evaluate-phase0.spec.ts
npx prisma validate
```

Los dos scripts ejecutan `node dist/scripts/evaluate-phase0.js` después del build; no usan `ts-node`. `--out` escribe cada resultado en un archivo temporal y publica un JSON completo al terminar. Así el proceso conserva sólo el resultado actual, aunque el reporte final siga siendo un JSON revisable. Sin `--out`, el JSON se transmite a stdout. El proceso termina con código 1 si hay `FAIL_CRITICAL` o `ERROR_INFRA`; `FAIL_QUALITY` queda en el reporte y no rompe el gate de seguridad offline. `PASS` no reemplaza la revisión de calidad del proveedor: el doble offline no mide redacción, pertinencia ni consistencia conversacional real.

El fixture se mantiene en versión 1. Las extensiones opcionales son `commercialSnapshot`, `market`, `serviceCode`, `profile`, `contactName`, `inboundKind` y `deliveryWindow`; no se requieren datos productivos. `direct-price` incluye un importe **sintético** de USD 137.00 para probar autorización, mercado y moneda. `campaign-opt-out` usa un botón sintético y `closed-24h-window` simula un worker que responde más de 24 horas después del inbound.

## Modo provider con autorización posterior

Ejecutar únicamente cuando el operador autorice explícitamente llamadas a los modelos:

```bash
npm run build
HERMES_PHASE0_PROVIDER_EVALUATION=true node dist/scripts/evaluate-phase0.js --provider --out phase0-provider.json
```

Se pueden añadir `--case <id>` y `--engine nous_hermes|gemini_direct`. La concurrencia provider es 1: cada caso y engine terminan y se escriben antes del siguiente. Los 24 fixtures se cargan una sola vez; no se retienen los 48 resultados. El harness crea dobles y servicios por caso, sin `TestingModule`, PrismaClient real ni conexión persistente que cerrar. Los clientes provider se construyen sólo cuando el flujo invoca el engine elegido. Las clases provider todavía pueden cargarse indirectamente al importar `AutoReplyService`; esto no crea clientes ni llamadas. El motor Gemini usa `HermesService` y su configuración normal de `HERMES_API_URL`, `HERMES_API_KEY` y `HERMES_MODEL`. Nous usa `NousHermesTransport`, `AgentOutputValidator`, el endpoint privado fijado por el contrato y `NOUS_HERMES_API_KEY_FILE`. El harness llama directamente al transporte Nous para no levantar BullMQ/Redis; `AutoReplyService` sigue procesando el resultado por la misma política final. La bandera de autorización se comprueba **antes** de construir un cliente de proveedor. No editar `.env` para cambiar de motor.

Medición local (Node 24 en Windows; proceso nuevo por smoke, heap limitado a 396 MB para comparar): con `ts-node`, cargar el harness consumió 504–532 MB de heap y el smoke falló con el límite de 396 MB. Desde JS compilado, un smoke provider con respuesta simulada terminó con 38–39 MB de heap y 118 MB de RSS; no hizo llamadas a proveedores ni a Meta. El recorrido offline completo terminó con 41 MB de heap, 118 MB de RSS, 29 `PASS`, 19 `FAIL_QUALITY`, 0 `FAIL_CRITICAL` y 0 `ERROR_INFRA`. En 48 ejecuciones provider simuladas secuenciales, el heap usado fue 40, 42, 44 y 49 MB tras los casos 1, 5, 10 y 24; después de GC de diagnóstico fue 31, 31, 32 y 32 MB. Estos valores no sustituyen la validación en VPS con Node 20 ni miden el tamaño de respuestas reales de los modelos.

El informe incluye caso, motor, modelo, hash del código de prompt/transporte, texto final, latencia, rechazos de propuestas, sustituciones, guards, errores, tokens cuando el proveedor los devuelve y entrega fake. No estima costos. Los controles semánticos basados en expresiones regulares son aproximaciones; revisar cada `FAIL_QUALITY` y las respuestas `PASS` antes de decidir sobre Fase 0.

## Procedimiento VPS

Obtener el commit publicado y crear un worktree aislado para la evaluación. Mantener `hermes-app` sin cambios.

```bash
git fetch origin
git worktree add --detach /tmp/phase0-harness-validation <SHA_NUEVO_DEL_HARNESS>
cd /tmp/phase0-harness-validation
cd hermes-backend
npm ci
npm run build
npm run evaluate:phase0:offline -- --out phase0-offline.json
```

Revisar `phase0-offline.json`, confirmar `fixtureCount=24`, `evaluated=48`, `delivery.metaCalls=0` en los 48 resultados y ausencia de `ERROR_INFRA`/`FAIL_CRITICAL`. Si existe autorización para evaluar modelos, ejecutar después el comando provider compilado anterior y revisar `phase0-provider.json`. El bundle local `phase0-final-output-harness.bundle` queda como alternativa si `origin` no está disponible. No hay contenedores ni tablas que desmontar. La Fase 0 permanece abierta hasta que el operador revise el reporte provider y sus hallazgos.
