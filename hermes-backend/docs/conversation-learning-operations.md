# Operación de revisión de conversaciones (Fase 2)

**Estado documental (15/10/2026):** F1 y F2 están **CLOSED** según el [plan maestro](hermes-learning-loop-plan.md), con harness aislado, canary controlado, revisión humana y evaluación provider F2 ya registrados allí. F3 sigue **OPEN**: aprobación y sombra tuvieron despliegue técnico, y el core retrieval se probó offline en `231b119`, sin desplegarlo ni activar aprendizaje. Los cuatro flags `LEARNING_*` y las allowlists se reportaron apagados/vacíos en ese corte; su estado servido actual requiere auditoría VPS de solo lectura. Esta guía describe la operación del reviewer; las actas del 08/10 que siguen son antecedentes, no pendientes vigentes.

## Activación y aislamiento

`LEARNING_REVIEW_ENABLED=false` impide programar y procesar revisiones. Mantener también `LEARNING_RETRIEVAL_ENABLED=false`, `LEARNING_SHADOW_ENABLED=false` y `LEARNING_SUMMARY_ENABLED=false` hasta una decisión nueva documentada. La cola `conversation-learning-reviews` es independiente de `automatic-whatsapp-replies`. Su worker tiene concurrencia 1, tres intentos y backoff exponencial. Un fallo al programar una revisión se registra sin revertir el feedback ni una entrega ya confirmada.

Las puertas de implementación y evaluación de F2 se cerraron; eso no activa revisión productiva general. Antes de cambiar el flag en un entorno servido, comprobar la política de retención vigente, el alcance autorizado, cuota, costo, colas y procedimiento de reversión según el plan maestro. La política reportada al 15/10 tiene backup periódico y restore-check desactivados; no presentarlos como servicios operativos.

### Procedimiento acotado del canary F2

`LEARNING_REVIEW_ENABLED=false` detiene scheduler y worker. Para el canary F2, `LEARNING_REVIEW_CANARY_FEEDBACK_IDS` admite únicamente UUID de feedback separados por comas; lista vacía o whitespace admite cero feedbacks y tokens inválidos detienen el arranque. La lista se lee al iniciar y cualquier cambio exige reinicio. No existe modo global implícito. Retrieval, shadow y summary permanecen apagados para esa prueba.

`POST /api/learning/reviews/canary` requiere JWT ADMIN y `{ "feedbackId": "<uuid>", "requestKey": "<uuid>" }`. Devuelve `feedbackId`, `reviewId`, `status`, `scheduled` y `reused`; 401 indica JWT ausente, 403 rol o feedback fuera de alcance, y 409 clave asociada a otro feedback o review incompatible. Antes de reutilizar `scheduleBadFeedback`, comprueba feedback BAD, outbound Hermes y entrega confirmada. `requestKey → feedbackId` se registra en `AuditLog` bajo bloqueo transaccional PostgreSQL; un reintento con la misma clave puede completar un agendado transitoriamente fallido sin duplicar el efecto lógico.

El feedback fuera de la allowlist se guarda, pero no crea review ni job en el canary. Los incidentes AutoReply no tienen `feedbackId` y quedan fuera de este procedimiento. Al iniciar, sólo se reencolan reviews `PENDING` de feedback permitido; un job previo fuera de alcance termina sin reclamar review, llamar al modelo ni reintentarse. `review-<reviewId>` y `reviewKey` identifican el job y review lógicos. La comprobación cuenta reviews por `feedbackId`, jobs por `reviewId`, candidatos por `sourceReviewId` e items `ACTIVE`; ningún candidato se activa automáticamente. Estas reglas describen el canary F2, no todas las fuentes posibles del reviewer general.

## Entradas y salidas

### Alcance general del reviewer

El flujo general contempla feedback `BAD` ligado a un outbound Hermes con `AutomatedDelivery.CONFIRMED`, o un incidente que requirió revisión humana tras confirmar al menos una parte de la entrega. El canary F2 anterior sólo agenda feedback `BAD` permitido; no incluye incidentes AutoReply. La clave de revisión incluye fuente, motivo y versión de rúbrica. Una ventana máxima de 12 mensajes de la misma conversación y 24 horas se redacta antes de llamar al proveedor configurado. No se copian transcripciones a tablas nuevas.

La salida del modelo debe cumplir el contrato JSON estricto. Sólo se guarda diagnóstico breve; un candidato exige IDs de mensajes presentes en esa ventana. `NO_LEARNING` significa que la evidencia no sostiene una pauta. El reviewer deja candidatos `PROPOSED`; su aprobación/rechazo/retiro ADMIN es una función separada de F3. La lista de candidatos se consulta en `/admin/crm/aprendizajes` y `GET /api/learning/candidates`.

## Cuotas y fallos

`LEARNING_REVIEW_DAILY_LIMIT` limita la programación diaria (valor inicial 10; máximo 100). Tras tres revisiones fallidas durante la última hora no se programan nuevas revisiones. Las fallidas quedan registradas como `FAILED`; en el canary F2 sólo se reencolan pendientes de feedback permitido con la flag activa. El proveedor usa `LEARNING_REVIEW_MODEL` o `HERMES_MODEL`, con un máximo de 500 tokens de salida por llamada. La cuota y el costo real deben medirse antes de activar producción.

Para detener la revisión, fijar `LEARNING_REVIEW_ENABLED=false` y reiniciar el backend controladamente. No borrar la cola ni las tablas como respuesta a un incidente. Antes de reactivar, revisar fallos, evidencia, límites de proveedor y trabajos pendientes.

## Decisiones y sombra de Fase 3 (implementación local)

`POST /api/learning/candidates/:id/decision` exige JWT ADMIN, `action` (`APPROVE`, `REJECT` o `RETIRE`) y motivo de 10 a 500 caracteres sin datos de contacto. Aprobar exige evidencia y vencimiento futuro de hasta 180 días. Se audita el cambio de estado con operador, motivo y versión; `APPROVE` y `REJECT` parten de `PROPOSED`, y `RETIRE` parte de `ACTIVE`. Un conflicto de estado devuelve 409. No se edita el texto del candidato en esta fase; una futura corrección de contenido necesitará una versión nueva.

`LEARNING_SHADOW_ENABLED=false` por defecto. La implementación técnica consulta elementos `ACTIVE` y registra IDs/versiones y tiempo sin insertar guidance en el prompt. La rama `f3-core-retrieval` añadió una ruta compartida de selección e inyección protegida al contrato de ambos motores, probada **offline**. La rama `f3-shadow-gate` (`620c64d`) comprobó después paridad de request/salida con ambos motores y providers fake, selección y aislamiento de fallos; F3 sigue abierta. `LEARNING_RETRIEVAL_ENABLED=false` permanece reportado en producción. Aprobar un candidato no cambia por sí solo las respuestas con retrieval apagado.

## Datos y retención

Los candidatos contienen pautas generales, nunca precios ni datos de otra persona. El filtro automático redacta patrones comunes de correo/teléfono y rechaza salidas que los contengan. La evidencia apunta a registros fuente y cuenta conversaciones distintas. Retención, recuperación e invalidación de candidatos sin evidencia se validaron para F2; la política configurable y sus deudas operativas constan en §9 del plan maestro. Las flags siguen apagadas por decisión de activación, no por una puerta F2 pendiente.
