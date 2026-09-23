# Conversación comercial de Nous: auditoría local y despliegue focalizado

Fecha: 2026-09-22. HEAD inicial: `51024c59700ee1dad72d7483c7d34266bf29bac5`.

## Dónde se forma la respuesta

- La petición privada la construye `NousHermesTransport.messages()`: incluye un mensaje `system` escrito en el CRM, hasta 20 mensajes recientes y un último mensaje `user` con estado comercial y mensaje actual. El transporte no lee ni envía `SOUL.md` explícitamente. La ruta efectiva del agente es el alias privado `hermes-agent` por Chat Completions, sin sesión ni herramientas.
- El handoff de VPS ubica `SOUL.md` en `/opt/hermes-agent/deploy/SOUL.md`, fuera de este repositorio. La petición podría estar sometida además a instrucciones internas del runtime, pero el código local no permite comprobar si el servidor incorpora ese archivo al endpoint privado. Se respetó la prohibición de acceder a la VPS; el contenido y la configuración efectiva de ese archivo quedan sin verificar. Editar `SOUL.md` no constituye una corrección demostrada de este flujo.
- El CRM decide tono y contrato en el `system` de `NousHermesTransport`; el perfil, historial y catálogo aportan hechos; `AutoReplyService` valida y repara; `AutomatedDeliveryService` envía. Los saltos de línea del texto no crean mensajes independientes. `replyParts` sí lo hace y `replyText` sigue siendo válido.
- La ficha persistida del CRM tenía un solo `sector`/`need`. `businessNeeds` conserva literalmente la descripción de varios negocios del cliente, con evidencia del mensaje actual. El historial reciente también llega al modelo. No se hace una migración de base de datos.

## Fuentes y alcance autorizado

| Fuente | Gemini directo | Nous antes | Estado para Nous tras este cambio |
| --- | --- | --- | --- |
| `commercial-catalog.ts` versionado | Sí | Sí, seleccionado por consulta | Sí. Ahora conserva las tres soluciones cuando hay servicios para promocionar y productos para vender online. |
| Productos y listas activas y vigentes en PostgreSQL | `HermesService.loadBusinessContext()` | No | No. Falta resolver autoridad y validación por producto antes de admitir esos importes en Nous. |
| Documentos comerciales activos | `HermesService.loadBusinessContext()` | No | No. No hay mecanismo de aprobación adicional aparte de `isActive`; podrían contradecir el catálogo. |
| Playbooks activos | `HermesService.loadBusinessContext()` | No | No. No se tratan como tarifas o promesas. |
| Sitio público | Sin consulta fiable en tiempo real | Sin consulta fiable | Referencia para conciliación humana, no fuente de la respuesta CRM. |
| Historial y datos del cliente | Contexto de necesidades | Contexto de necesidades | Nunca autorizan tarifas, descuentos ni condiciones de Undercodeec. |

El catálogo versionado existente se denomina “oficial del configurador” y es la única fuente de precios que el validador de Nous admite ahora. No se ha encontrado una definición de negocio que resuelva automáticamente discrepancias entre catálogo, tablas activas y sitio. Por ello, este cambio no eleva los otros importes a autoridad ni elige el precio más reciente o bajo. Hace falta una decisión comercial explícita y una sincronización verificable antes de ampliar la fuente de precios de Nous.

La [página española](https://undercodeec.com/es/) muestra promociones en euros (landing desde 80 €, web de lanzamiento desde 120 € y tienda desde 250 €) y alcances distintos. La [página ecuatoriana](https://undercodeec.com/ec/) menciona landing desde USD $250, pero no establece que los demás importes y condiciones del catálogo CRM sean los vigentes para todo cliente. No hay consulta ni sincronización de esas páginas en el backend. El CRM no debe reproducir promociones ni plazos del sitio por inferencia.

| Solución del catálogo CRM | Precio publicado en el catálogo | Diferencia y límite documentado | Plazo |
| --- | --- | --- | --- |
| Landing Básica | USD $250, IVA incluido | Una página para presentar servicios y captar contactos. | Sin plazo autorizado en catálogo. |
| Plan de Lanzamiento (sitio web) | USD $360, IVA incluido | Hasta 5 páginas para organizar la información y los servicios. | Sin plazo autorizado en catálogo. |
| Tienda de Lanzamiento | USD $550, IVA incluido | Catálogo administrable, carrito y pago seguro; carga inicial hasta 20 productos. | Sin plazo autorizado en catálogo. |
| Desarrollo a medida | Sin precio publicado aplicable | Requiere valoración del alcance. | Sin plazo autorizado. |

El catálogo también contiene otras variantes de landing, sitio y tienda; el prompt muestra solo las pertinentes a la consulta. La cobertura de IVA y alcance se aplica a estos importes del catálogo, no a importes mencionados por clientes ni a promociones del sitio. Para cobros, pagos, descuentos y plazos sin fuente de autoridad, Nous debe indicar que el equipo debe confirmarlos.

## Diagnóstico del texto observado

La ruta anterior `commercialCatalogContext()` daba prioridad absoluta a tienda online. Ante los dos negocios, el contexto de Nous podía omitir las fichas de landing y sitio web. El validador de precios recibía además un alcance construido con el mensaje actual, producto de interés y el único `service` persistido; si no reconocía la landing, `AutoReplyService` reemplazaba el importe propuesto por `un precio sujeto a valoración`, produciendo la frase poco natural observada. Esta es una causa demostrable en el código para esa forma de salida; no hay traza del turno real que permita afirmar si el modelo omitió un precio recibido o si el reemplazo exacto ocurrió en ese incidente. Ahora se conservan las opciones de ambos negocios y se elimina una oración con un importe sin respaldo, preservando las demás oraciones válidas.

La revisión de Nous comprueba cada importe contra la solución nombrada en su cláusula, además del alcance autorizado. No acepta USD $360 como precio de Tienda de Lanzamiento. El CRM sigue retirando afirmaciones de descuentos, plazos de entrega, condiciones de pago, inclusiones no respaldadas y acciones sin confirmación. Las partes propuestas se validan como texto y se entregan por el ledger en orden, con una exclusión por conversación durante el lote. Una entrega ambigua corta el lote; un nuevo mensaje entrante impide reclamar partes posteriores. No se reenvían entregas ambiguas.

## Verificación y despliegue

La conversación de lavadoras y zapatos se reproduce en pruebas sintéticas del catálogo y de `AutoReplyService`; comprueba las tres soluciones, los tres mensajes ordenados, precios vinculados y plazo sin inventar. No sustituye una prueba real del runtime Nous ni permite verificar `SOUL.md` sin entrar a la VPS.

Tras aprobar la conciliación de precios para el público objetivo, en la VPS el operador puede actualizar el checkout de `origin/main`, construir solo `app` y recrear solo ese servicio con el procedimiento del [runbook](nous-hermes-runbook.md). No se requiere migración Prisma para este cambio. Verificar una conversación de prueba permitida, el ledger `automated_deliveries` y los rechazos comerciales antes de ampliar tráfico. El rollback de motor sigue siendo `HERMES_CONVERSATION_ENGINE=gemini_direct` con `NOUS_HERMES_OPEN_INBOUND_TEST=false`. Este cambio no se desplegó desde local.
