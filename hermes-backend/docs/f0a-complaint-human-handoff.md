# F0A: reclamos y control humano

Estado local: **listo para validación controlada en VPS**. F0A aún no está cerrada.

## Causa raíz

`human-request` entraba en `CommercialPolicy.requestsHuman` y creaba un handoff antes del motor. Un reclamo explícito no cumplía esa regla y seguía hasta el motor. Después, Nous requería que su propuesta incluyera `request_handoff`; Gemini dependía del intent o de palabras clave evaluadas tras generar texto. Por eso ambos podían prometer atención humana sin registrar el handoff.

## Corrección

La política comercial reconoce solicitudes de queja o reclamo sobre el servicio, sin escalar mero sentimiento negativo. AutoReply crea o reutiliza el handoff `COMPLAINT` antes de invocar cualquier engine o preparar el acuse. Usa `HandoffService.create`, que adquiere `pg_advisory_xact_lock` por conversación, conserva los handoffs `PENDING`, `ASSIGNED` o `IN_PROGRESS` y actualiza la conversación a `HANDED_OFF`. El acuse solo indica que el caso quedó registrado y pendiente de asignación.

Las entregas comerciales preparadas sin `allowHandedOff` se suprimen en la comprobación final de `AutomatedDelivery` con `HANDOFF_ACTIVE`. Las respuestas humanas siguen exigiendo ownership `IN_PROGRESS` según `ConversationsService`.

## Regresiones locales

Pruebas de reclamo y queja equivalente, sentimiento negativo sin solicitud, solicitud humana explícita, ambos engines sin invocación, reutilización `PENDING`/`IN_PROGRESS`, dos inbounds concurrentes, supresión de delivery y ownership humano. La batería sintética F0 cubre también `invented-price`, `project-payment`, `store-customer-payment` y `conversation-a-private-context`.

No se requiere migración. Learning permanece desactivado. Pendiente: despliegue controlado, smoke sintético, verificación del handoff y validación E2E autorizada desde Inbox.
