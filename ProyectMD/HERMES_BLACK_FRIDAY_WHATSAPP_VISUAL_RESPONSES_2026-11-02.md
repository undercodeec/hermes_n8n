# Respuestas visuales Black Friday por WhatsApp — 2026-11-02

## Comportamiento anterior

Ante «¿Qué incluye?», `AutoReplyService` sustituía la propuesta de Nous por las diez cláusulas del `scope` en una lista numerada dentro de una sola respuesta. Una pregunta sobre una prestación concreta podía parecerse a una solicitud de catálogo completo. El divisor por longitud podía cortar una respuesta sin respetar introducción, prestaciones y continuación comercial.

## Cambio implementado

El formato especial se activa únicamente cuando la `CommercialSnapshot` selecciona la promoción Black Friday vigente y el cliente solicita todas las prestaciones. Las diez cláusulas siguen procediendo de la `PriceList`; se muestran con emojis moderados, saltos de línea y negrita nativa de WhatsApp para el soporte. La respuesta se prepara como tres partes semánticas: introducción, lista y una pregunta. `AutomatedDeliveryService` conserva el orden, el historial por mensaje, los reintentos y la idempotencia del lote. Si F3 permite dos o una parte, las mismas prestaciones se compactan con la pregunta en el límite disponible. No se modificaron los límites globales del splitter ni del transporte.

La consulta inicial general mantiene una respuesta breve con precio solo si existe una tarifa aprobada y vigente. Las preguntas puntuales de hosting y soporte utilizan la cláusula correspondiente del `scope` y no despliegan el catálogo. Las conversaciones de otros servicios y los estados STOP, opt-out o handoff conservan sus controles anteriores.

## Ejemplo con el `scope` vigente

Mensaje 1:

> Claro. Estas son las prestaciones de la promoción Black Friday:

Mensaje 2:

```text
🎯 Captación de clientes potenciales
🖥️ Landing Page de una sola sección
📱 Diseño responsive, optimizado para celulares
💬 Botón flotante de WhatsApp y llamada directa
📝 Formulario de contacto o captura de prospectos
⭐ Sección de beneficios del servicio o producto
🌍 Dominio .com y hosting básico por 1 año
📧 5 correos corporativos
🔍 SEO técnico base
🛠️ *1 mes de soporte posterior a la entrega*
```

Mensaje 3:

> ¿A qué se dedica su negocio?

Cuando el perfil ya indica una barbería, la pregunta se adapta para destacar sus servicios o facilitar consultas por WhatsApp. Si esa pregunta de descubrimiento ya fue formulada y el perfil sigue sin dato, no se repite. Cuando el cliente solicita simultáneamente precio y prestaciones, la introducción usa exclusivamente la respuesta de precio autorizada por `PriceList`.

## Tarifas y soporte

La promoción sin tarifa aplicable o sin vigencia no autoriza comunicar USD 80 en Ecuador ni EUR 80 en España. La ruta existente pide confirmación de la tarifa correspondiente sin convertir monedas. El catálogo visual completo requiere que exista una oferta de campaña seleccionada con sus diez cláusulas autorizadas; no se deriva del texto del cliente.

La `PriceList` disponible en esta rama mantiene *1 mes de soporte posterior a la entrega*. El formato *1 año de soporte técnico posterior a la entrega* solo aparece cuando la cláusula décima de la `PriceList` vigente indique expresamente `12 meses` o `1 año` de soporte. Este cambio comercial requiere registro y activación por el responsable del CRM; el código no activa ni modifica la tarifa ni la duración.

## Validación

La prueba focalizada de `AutoReplyService` y del formateador pasó con 215 casos. La suite unitaria completa pasó con 105 suites y 1740 pruebas. El gate de integración aislado pasó con 18 suites, 188 pruebas y un caso omitido permitido por el gate. A7-D16 pasó con 6 suites y 31 pruebas. Build, Prisma validate, security secrets y ESLint global pasaron.

## Despliegue y rollback

No se desplegó desde Codex Local. Antes de desplegar, revisar la rama y el PR, confirmar en CRM qué promociones y mercados están activos, y ejecutar en el entorno de entrega los gates documentados. Publicar el backend mediante el runbook de VPS y verificar en una conversación de prueba los tres `wamid` en orden, cada uno con su registro outbound correspondiente. Verificar también una consulta general, una pregunta puntual, STOP, un handoff y el mercado sin tarifa.

Para rollback, volver a la imagen o commit de backend anterior mediante el runbook de VPS. Este cambio no agrega migraciones ni altera datos comerciales; la `PriceList` vigente permanece como autoridad. Si el CRM actualiza el soporte a doce meses después del despliegue, revertir esa actualización comercial por separado solo si el responsable del CRM lo decide.
