# Operación comercial Black Friday

> **Protocolo vigente**, contrastado con código `ca85b991` el 10/11/2026. No autoriza activar campañas, modificar CRM, tarifas o servicios. Estado de release y despliegue: [estado del proyecto](../../ProyectMD/estado-proyecto.md).

## Autoridad y alcance

Este protocolo concentra el preflight y la validación comercial; [piloto R6](undercodeec-pilot-runbook.md), [conciliación comercial de septiembre](commercial-authority-handoff-2026-09-23.md) y [plan original USD 80](superpowers/plans/2026-10-29-black-friday-landing-80.md) son antecedentes preservados. El nombre de política `black-friday-landing-80-v1` identifica código, no prueba una tarifa activa ni una moneda universal.

`CommercialAuthorityService` construye `CommercialSnapshot` desde productos/listas autorizadas y resolución de mercado; el consumidor no debe sustituirlo por el seed, una web, memoria del LLM, teléfono aislado o una oferta histórica. Comprobar en el entorno aprobado actividad, vigencia, mercado, moneda, impuestos, alcance, restricciones y relación de promoción con la lista sustituida. No actualizar registros desde esta guía.

La resolución está en `src/hermes/commercial-market-resolver.ts`; la elegibilidad de promoción en `black-friday-landing.ts`, `verified-ad-campaign.ts` y `commercial-authority.service.ts`. La evidencia de anuncio verificada y acotada temporalmente no se fabrica desde texto del cliente. Una corrección explícita de mercado, una moneda ambigua, un rechazo de promoción o una petición de otro servicio requieren respetar las reglas de aclaración/selección del snapshot. No afirmar que todo prefijo español activa EUR, ni que todo anuncio activa la promoción.

## Preflight comercial de solo lectura

1. Verificar versión servida y datos aprobados según [despliegue](deployment-runbook.md). No basta que la función exista en Git.
2. Identificar responsable comercial y conversación QA con autorización de entrega. Confirmar mercado y alcance pretendidos sin introducir datos de clientes en fixtures.
3. Revisar configuración efectiva de campaña (`HERMES_BLACK_FRIDAY_AD_SOURCE_IDS`, ventana temporal y fallback Meta) sin copiar identificadores sensibles a las actas. No asignar valores de ejemplo como producción.
4. Revisar selección de motor y piloto. `ConversationEngineService` da prioridad a `assignedEngine`; `HERMES_PILOT_NEW_CONVERSATION_ENGINE` y las asignaciones persistidas requieren control separado de `HERMES_CONVERSATION_ENGINE`, allowlist y modo abierto. El rollback global no garantiza cambiar conversaciones ya asignadas.
5. Revisar interruptores de admisión/operaciones y presupuesto del piloto. `MONITOR_ONLY` modifica límites presupuestarios, **no** equivale a activar tráfico ni a capacidad ilimitada. No usar cuotas cero o enormes como sustituto de la política.

## Matriz mínima de validación con fakes

| Caso | Evidencia esperada |
| --- | --- |
| Solicitud explícita de promoción / referencia verificada | Oferta elegible del snapshot; sin inventar moneda, vigencia o impuestos |
| España, Ecuador, ubicación desconocida y corrección de mercado | Resolver o aclarar conforme al código, sin convertir por intuición EUR/USD |
| Presupuesto personal de 80, rechazo o cambio a otro servicio | No confundir presupuesto con campaña ni mantener promoción rechazada |
| Pregunta de alcance, entrega, renovación o pago | Solo condiciones autorizadas; ninguna promesa derivada del nombre de política |
| Replay del mismo inbound, timeout y resultado tardío Nous | Una reserva/continuación durable; sin regeneración ni envío ciego |
| Handoff, opt-out o intervención humana | Respetar supresión y autoridad humana antes de entrega |

Referencias de pruebas existentes: `src/hermes/commercial-authority.service.spec.ts`, `src/auto-replies/auto-reply.service.spec.ts` y pruebas de resolución de mercado/atribución. Ejecutarlas con dependencias simuladas no autoriza un smoke real. Registrar comando, resultado y límite; no reutilizar resultados de actas antiguas como nueva validación.

Selección reproducible desde `hermes-backend/`, sin lanzar servidor ni activar campañas:

```sh
npm test -- --runInBand --runTestsByPath src/hermes/black-friday-landing.spec.ts src/hermes/verified-ad-campaign.spec.ts src/hermes/commercial-authority.ad-campaign.spec.ts src/hermes/commercial-authority.service.spec.ts src/hermes/commercial-support-maintenance.spec.ts
```

Esta selección no sustituye la regresión completa, el harness durable ni la inspección autorizada del runtime. Las condiciones del snapshot (incluido soporte/mantenimiento) deben comprobarse con datos aprobados; el nombre histórico «80» no permite extrapolar importes o renovación. Tampoco atribuir a este HEAD el ajuste España del [PR 19](https://github.com/undercodeec/hermes_n8n/pull/19): al revisar el 10/11/2026 sigue abierto en `63bd52a`, sin integración ni imagen acreditada del cambio. La publicación piloto `ca85b991` no resuelve esa diferencia y producción sigue sin verificarse.

## Integraciones: código no significa activación

- **Nous:** selección en `src/conversation-engine`, transporte privado y cola en `src/integrations/nous-hermes`. El backend valida propuestas; Nous no administra directamente tarifas ni ejecuta operaciones CRM. [Contrato y operación](nous-hermes-runbook.md).
- **Pagos:** `src/payments/payments.controller.ts` implementa cuentas y revisión/aprobación/rechazo de transferencias; aprobación/rechazo requieren ADMIN. Un comprobante no equivale a pago confirmado. `PAYMENTS_TRANSFER_ENABLED=false` en `.env.example` no demuestra el flag servido. [Plan y antecedentes](transfer-payment-crm-implementation-plan.md).
- **Publicidad:** `src/advertising/advertising.controller.ts` implementa contact-intents y rutas administrativas; atribución, consentimiento y conversión verificada son distintos de gasto facturado o campaña activa. No activar envíos ni sync por comprobar la ruta. [Guía temática](advertising-attribution.md).
- **Calendar:** existen `GET /api/meetings` y OAuth de desarrollo; reserva/disponibilidad se gestionan mediante servicios y operaciones durables, no por promesa del agente. `GOOGLE_CALENDAR_ENABLED=false` en el ejemplo no acredita configuración real. [Calendar](google-calendar-runbook.md).
- **Learning:** candidatos/reviews existen en `src/learning/learning.controller.ts`; los cuatro flags del ejemplo están OFF. La aprobación de un candidato no activa retrieval ni un canary general. No inferir flags efectivos de actas, defaults o migraciones. [Operación learning](conversation-learning-operations.md).

## Cierre y parada

Registrar evidencia sanitizada: versión, mercado resuelto, oferta/política, IDs técnicos, motor y estado final de entrega. Uso/tokens estimados no son factura; nulos siguen desconocidos. Ante atribución dudosa, precio no autorizado, duplicado o estado ambiguo, detener nuevas pruebas/admisiones mediante el procedimiento autorizado y derivar a revisión humana. Conservar ledger, reservas y resultados durables. Desactivar una campaña o cambiar tarifas en CRM requiere decisión comercial separada; no borrar datos para simular rollback.
