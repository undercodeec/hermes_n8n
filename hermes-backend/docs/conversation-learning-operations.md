# Operación de revisión de conversaciones (Fase 2)

Estado: migración `20261008200000_conversation_learning_review` aplicada y Fase 2 desplegada técnicamente según acta VPS del 08/10/2026. La revisión sigue apagada. Falta el harness E2E aislado descrito en `hermes-learning-loop-plan.md`; la implementación inicial local de Fase 3 aún no está desplegada.

## Activación y aislamiento

`LEARNING_REVIEW_ENABLED=false` impide programar y procesar revisiones. Mantener también `LEARNING_RETRIEVAL_ENABLED=false` y `LEARNING_SUMMARY_ENABLED=false`. La cola `conversation-learning-reviews` es independiente de `automatic-whatsapp-replies`. Su worker tiene concurrencia 1, tres intentos y backoff exponencial. Un fallo al programar una revisión se registra sin revertir el feedback ni una entrega ya confirmada.

Antes de habilitar revisión se necesitan: Fase 1 validada con fixture autorizado, restauración aislada de backup, capacidad/costo medidos, política de retención definida y evaluación de privacidad del corpus sintético. No habilitarla sólo porque la migración aplique correctamente.

## Entradas y salidas

Se programa una revisión para feedback `BAD` ligado a un outbound Hermes con `AutomatedDelivery.CONFIRMED`, o para un incidente que requirió revisión humana tras confirmar al menos una parte de la entrega. La clave de revisión incluye fuente, motivo y versión de rúbrica. Una ventana máxima de 12 mensajes de la misma conversación y 24 horas se redacta antes de llamar al proveedor configurado. No se copian transcripciones a tablas nuevas.

La salida del modelo debe cumplir el contrato JSON estricto. Sólo se guarda diagnóstico breve; un candidato exige IDs de mensajes presentes en esa ventana. `NO_LEARNING` significa que la evidencia no sostiene una pauta. Un candidato queda `PROPOSED`, con `NEEDS_REVIEW`; esta fase no tiene aprobación ni recuperación al responder. La vista `/admin/crm/aprendizajes` y `GET /api/learning/candidates` son de solo lectura para ADMIN.

## Cuotas y fallos

`LEARNING_REVIEW_DAILY_LIMIT` limita la programación diaria (valor inicial 10; máximo 100). Tras tres revisiones fallidas durante la última hora no se programan nuevas revisiones. Las fallidas quedan registradas como `FAILED`; las pendientes se reencolan al iniciar la app si la flag está activa. El proveedor usa `LEARNING_REVIEW_MODEL` o `HERMES_MODEL`, con un máximo de 500 tokens de salida por llamada. La cuota y el costo real deben medirse antes de activar producción.

Para detener la revisión, fijar `LEARNING_REVIEW_ENABLED=false` y reiniciar el backend controladamente. No borrar la cola ni las tablas como respuesta a un incidente. Antes de reactivar, revisar fallos, evidencia, límites de proveedor y trabajos pendientes.

## Decisiones y sombra de Fase 3 (implementación local)

`POST /api/learning/candidates/:id/decision` exige JWT ADMIN, `action` (`APPROVE`, `REJECT` o `RETIRE`) y motivo de 10 a 500 caracteres sin datos de contacto. Aprobar exige evidencia y vencimiento futuro de hasta 180 días. Se audita el cambio de estado con operador, motivo y versión; `APPROVE` y `REJECT` parten de `PROPOSED`, y `RETIRE` parte de `ACTIVE`. Un conflicto de estado devuelve 409. No se edita el texto del candidato en esta fase; una futura corrección de contenido necesitará una versión nueva.

`LEARNING_SHADOW_ENABLED=false` por defecto. Si se habilita para una evaluación autorizada, consulta sólo elementos `ACTIVE` no vencidos y compatibles con servicio/mercado; registra hasta tres IDs/versiones coincidentes, motor y tiempo sin insertar guidance en el prompt ni enviar nada a Meta. La calidad de esas coincidencias debe evaluarse antes de introducir recuperación efectiva. `LEARNING_RETRIEVAL_ENABLED=false` continúa sin una ruta de inyección de memoria; aprobar un candidato no cambia por sí solo las respuestas.

## Datos y retención

Los candidatos contienen pautas generales, nunca precios ni datos de otra persona. El filtro automático redacta patrones comunes de correo/teléfono y rechaza salidas que los contengan; esta protección requiere validación con casos sintéticos y revisión humana. La evidencia apunta a registros fuente y cuenta conversaciones distintas. La eliminación de fuentes y el retiro de candidatos sin soporte todavía requieren una política operativa definida; por eso la flag permanece apagada.
