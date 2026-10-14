# Operación de revisión de conversaciones (Fase 2)

Estado: F2 sigue abierta (`F2_OPERATIONAL_VALIDATED_CLOSURE_GAPS_REMAIN`) al 14/10/2026. Reviewer, retrieval, shadow y summary productivos permanecen OFF según el último corte reportado. Este cambio local de recuperación y soporte de evidencia requiere validación posterior en VPS; no equivale al cierre de `F2_RETENTION_RECOVERY_GATE`.

## Activación y aislamiento

### Control local de canary F2

`LEARNING_REVIEW_ENABLED=false` detiene scheduler y worker. Con la flag activa, `LEARNING_REVIEW_CANARY_FEEDBACK_IDS` admite únicamente los UUID de feedback separados por comas. La lista vacía (incluido whitespace) admite cero feedbacks; tokens inválidos detienen el arranque. La lista se lee al arrancar, por lo que cambiarla requiere reiniciar el backend. No existe un modo global implícito. `LEARNING_RETRIEVAL_ENABLED`, `LEARNING_SHADOW_ENABLED` y `LEARNING_SUMMARY_ENABLED` no son requisitos del reviewer canary y deben permanecer apagados durante la primera prueba.

`POST /api/learning/reviews/canary` requiere JWT con rol ADMIN y JSON `{ "feedbackId": "<uuid>", "requestKey": "<uuid>" }`. La respuesta contiene sólo `feedbackId`, `reviewId`, `status`, `scheduled` y `reused`; 401 indica ausencia de JWT, 403 deniega un rol distinto o un feedback fuera de la lista, 409 indica que la clave ya pertenece a otro feedback o existe una revisión incompatible. El endpoint comprueba feedback BAD, mensaje outbound Hermes y entrega confirmada antes de reutilizar `scheduleBadFeedback`. Un reintento con la misma clave puede completar un agendado que falló por una indisponibilidad transitoria. La relación `requestKey → feedbackId` queda en `AuditLog` y se serializa con un bloqueo transaccional PostgreSQL; no requiere migración.

El feedback nuevo se guarda normalmente aunque quede fuera de la lista; su review y job no se crean. Los incidentes AutoReply carecen de feedbackId y quedan fuera de este canary. El recovery revisa por lotes los reviews `PENDING` permitidos y los `PROCESSING` cuyo `processingAt` supera diez minutos, primero al arrancar y luego cada minuto. No toca un job BullMQ `active`; usa transición condicional en PostgreSQL y conserva `attempts`. El lote de 100 es independiente de `LEARNING_REVIEW_DAILY_LIMIT` y continúa en barridos posteriores. Los demás feedbacks quedan fuera del scope. Un job previo no permitido termina sin reclamar review ni llamar al modelo. El identificador `review-<reviewId>` y `reviewKey` preservan la identidad lógica. Ningún candidato se activa automáticamente.

`LEARNING_REVIEW_ENABLED=false` impide programar y procesar revisiones. Mantener también `LEARNING_RETRIEVAL_ENABLED=false` y `LEARNING_SUMMARY_ENABLED=false`. La cola `conversation-learning-reviews` es independiente de `automatic-whatsapp-replies`. Su worker tiene concurrencia 1, tres intentos y backoff exponencial. Un fallo al programar una revisión se registra sin revertir el feedback ni una entrega ya confirmada.

Antes de habilitar revisión se necesitan: Fase 1 validada con fixture autorizado, restauración aislada de backup, capacidad/costo medidos, política de retención definida y evaluación de privacidad del corpus sintético. No habilitarla sólo porque la migración aplique correctamente.

## Entradas y salidas

En el canary se programa una revisión sólo para feedback `BAD` permitido, ligado a un outbound Hermes con `AutomatedDelivery.CONFIRMED`. Los incidentes que requieren revisión humana quedan fuera del scope actual. La clave de revisión incluye fuente, motivo y versión de rúbrica. Una ventana máxima de 12 mensajes de la misma conversación y 24 horas se redacta antes de llamar al proveedor configurado. No se copian transcripciones a tablas nuevas.

La salida del modelo debe cumplir el contrato JSON estricto. Sólo se guarda diagnóstico breve; un candidato exige IDs de mensajes presentes en esa ventana. `NO_LEARNING` significa que la evidencia no sostiene una pauta. Un candidato queda `PROPOSED`, con `NEEDS_REVIEW`; esta fase no tiene aprobación ni recuperación al responder. La vista `/admin/crm/aprendizajes` y `GET /api/learning/candidates` son de solo lectura para ADMIN.

## Cuotas y fallos

`LEARNING_REVIEW_DAILY_LIMIT` limita la programación diaria (valor inicial 10; máximo 100), no el barrido de recuperación. Tras tres revisiones fallidas durante la última hora no se programan nuevas revisiones. El reviewer normal conserva tres claims durables como máximo; el canary/re-canary manual conserva una sola llamada al provider. `processingAt` y `attempts` permiten recuperar un claim normal obsoleto. Un canary nuevo deja marcas durables de claim y gasto antes de la llamada; uno antiguo `PROCESSING` sin marca suficiente se marca `FAILED` por ambigüedad. El proveedor usa `LEARNING_REVIEW_MODEL` o `HERMES_MODEL`, con un máximo de 2048 tokens de salida por llamada. La cuota y el costo real deben medirse antes de activar producción.

Para detener la revisión, fijar `LEARNING_REVIEW_ENABLED=false` y reiniciar el backend controladamente. No borrar la cola ni las tablas como respuesta a un incidente. Antes de reactivar, revisar fallos, evidencia, límites de proveedor y trabajos pendientes.

## Decisiones y sombra de Fase 3 (implementación local)

`POST /api/learning/candidates/:id/decision` exige JWT ADMIN, `action` (`APPROVE`, `REJECT` o `RETIRE`) y motivo de 10 a 500 caracteres sin datos de contacto. Aprobar exige evidencia y vencimiento futuro de hasta 180 días. Se audita el cambio de estado con operador, motivo y versión; `APPROVE` y `REJECT` parten de `PROPOSED`, y `RETIRE` parte de `ACTIVE`. Un conflicto de estado devuelve 409. No se edita el texto del candidato en esta fase; una futura corrección de contenido necesitará una versión nueva.

`LEARNING_SHADOW_ENABLED=false` por defecto. Si se habilita para una evaluación autorizada, consulta sólo elementos `ACTIVE` no vencidos y compatibles con servicio/mercado; registra hasta tres IDs/versiones coincidentes, motor y tiempo sin insertar guidance en el prompt ni enviar nada a Meta. La calidad de esas coincidencias debe evaluarse antes de introducir recuperación efectiva. `LEARNING_RETRIEVAL_ENABLED=false` continúa sin una ruta de inyección de memoria; aprobar un candidato no cambia por sí solo las respuestas.

## Datos y retención

Los candidatos contienen pautas generales, nunca precios ni datos de otra persona. El filtro automático redacta patrones comunes de correo/teléfono y rechaza salidas que los contengan; la revisión humana sintética del 14/10 detectó además privacidad semántica. Una evidencia es efectiva si conserva `messageId`, feedback `BAD` y review `PROPOSED` enlazados. `APPROVE`, lista de candidatos `PROPOSED` y selección shadow exigen al menos una evidencia efectiva; un `ACTIVE` huérfano no se selecciona incluso si su estado no se reconcilió. La eliminación coordinada de una fuente invalida un `PROPOSED` sin soporte a `REJECTED` o retira un `ACTIVE` a `RETIRED` dentro de la misma transacción y crea `AuditLog` automático sin texto ni PII. `ContactsService.remove` usa esta operación y cubre el borrado por cascada de conversaciones; no hay endpoints productivos de borrado directo de Conversation, Message, Feedback o Review. Borrados SQL/Prisma externos a esta operación no generan el audit automático y deben usarla para conservar esa trazabilidad; los guards de consumo siguen cerrados ante pérdida de soporte. Retención, copias y restauración siguen pendientes de política y validación VPS.
