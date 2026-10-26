# Piloto comercial UnderCodeEC: diseño propuesto

## Propósito y alcance

Habilitar en una fase posterior la atención comercial con Nous Hermes para conversaciones nuevas que lleguen al único número WhatsApp Business de UnderCodeEC, tanto desde anuncios de Meta como de forma orgánica. El código entregado debe permanecer DARK: sin activación, despliegue, push ni inferencias reales.

## Decisión de base

Partir de `a7/d4-nous-idempotency-local`, que ya persiste `metadata.pilotEngine` por conversación y protege el despacho Nous con una reserva durable por turno. `main` no incorpora esos cambios y contiene ediciones locales ajenas. Conservar el contrato Chat Completions privado actual hasta disponer del artefacto A7-D8 para comprobarlo explícitamente.

## Enfoques considerados

1. **Extender A7-D4 de forma local (elegido provisionalmente):** añadir la validación y clasificación en webhook, y controles operativos junto al borde Nous. Reutiliza metadatos de conversación, la tabla `InboundTurn` y el ledger de mensajes. Menor superficie y sin plataforma nueva.
2. Crear un servicio independiente de ruteo y observabilidad: separa responsabilidades, pero duplica estados y puntos de fallo para un solo número.
3. Desarrollar aislamiento multiempresa: permitiría expansión futura, pero contradice el alcance de esta fase y exigiría migraciones y pruebas de aislamiento.

## Comportamiento

- Aceptar eventos entrantes sólo si `value.metadata.phone_number_id` coincide con `META_PHONE_NUMBER_ID` configurado; nunca registrar el identificador como constante de código. Un evento sin ID válido no debe crear contacto, conversación ni trabajo Nous. Conservar la validación de firma existente.
- Clasificar el primer mensaje de una conversación como `meta_ad` cuando incluya `referral` publicitaria válida y como `organic` en otro caso. Registrar campos publicitarios permitidos cuando existan, sin bloquear la respuesta por su ausencia ni enviar datos de atribución a terceros. Mantener el origen inicial estable ante mensajes posteriores o reintentos.
- Asignar `nous_hermes` sólo a conversaciones nuevas que cumplan el número y los controles del piloto, con activación comercial explícita. Conservar el motor ya persistido al reabrir y al procesar nuevos mensajes. Las conversaciones previas sin asignación continúan en Gemini en modo piloto.
- Un interruptor de Nous impide nuevas solicitudes y no cambia el motor persistido. El flujo debe derivar o señalar para revisión humana los turnos detenidos sin emitir respuesta del agente.
- Usar la reserva durable existente para contar despachos Nous por día y evitar doble conteo de reintentos. Medir tokens y costo estimado cuando el proveedor los entrega; distinguir siempre estimación, consumo observado y gasto facturado desconocido. Emitir eventos estructurados al superar umbrales configurados de volumen, cola y gasto estimado.
- Reconocer bajas textuales comerciales inequívocas, registrar `OPTED_OUT` de marketing de modo idempotente y conservar la atención de servicio. Las solicitudes ambiguas no deben cortar el servicio.
- Proveer un reporte simple de conteos y resultados por `meta_ad` y `organic` a partir de metadatos y mensajes, sin panel nuevo.

## Restricciones y verificación

Mantener opt-out por botón, consentimiento de campañas, atribución existente, idempotencia de webhook y despacho, handoff y el contrato privado Nous actual. Probar con fixtures locales sin red ni proveedores reales. La suite base A7-D4 presentaba 3 suites F3 fallidas (6 pruebas) por invocaciones directas a Nous sin reserva durable; los fixtures locales de esas suites se adaptaron a la reserva A7-D4 sin relajar el transporte de producción.

## Pendientes de integración

El código/contrato de Nous Agent A7-D8 no está entre las ramas locales. La compatibilidad completa requiere ese artefacto. La base A7-D4 y este diseño siguen pendientes de confirmación del propietario.
