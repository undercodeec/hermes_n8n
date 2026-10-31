# Corrección de calidad conversacional de Nous — 31 de octubre de 2026

## Estado y procedencia

- Base productiva: `871d332ada0eb2dae22e9c39be367734090c3e76`.
- Rama aislada: `fix/nous-conversational-quality-20261031`.
- PR: https://github.com/undercodeec/hermes_n8n/pull/2 (base `pilot/a7-d12-monitor-only-20261026`).
- Sin integración ni despliegue. Ningún ensayo usó WhatsApp real.

## Causa raíz

`AutoReplyService` exigía que la respuesta del modelo contuviera el nombre **exacto** del plan para considerarla una recomendación. Ante la consulta general del anuncio, aunque el modelo ya explicaba la landing y el precio, el backend anteponía `recommended.scope` completo con las diez prestaciones. Al cambiar el texto, se descartaban los `replyParts` originales; `splitWhatsAppMessage()` dividía la oración larga por el umbral de 520 caracteres. Los dos envíos observados podían proceder de **una sola generación** y una sola preparación de entrega, sin necesitar una segunda inferencia.

Había dos fallos adicionales: `polishInitialGreeting()` solo reconocía saludos sin consulta y se ejecutaba antes del último fallback comercial; y el divisor convertía los saltos de línea de «¿Qué incluye?» en espacios. La segunda revisión detectó también que `¡Hola!` en la respuesta del motor podía duplicar el saludo y que una consulta general sin atribución Meta podía conservar dos `replyParts` de Nous.

## Cambios

| Archivo | Cambio |
| --- | --- |
| `hermes-backend/src/auto-replies/auto-reply.service.ts` | Evita anteponer la recomendación genérica a la oferta Black Friday; reduce el fallback general a producto, precio y un beneficio autorizado; conserva una respuesta útil del modelo; une partes cortas de consultas generales; aplica el saludo al texto final y formatea la oferta elegida en euros o dólares. Las recomendaciones ordinarias usan un fragmento pertinente del alcance y ya no abren con «Por lo que me comenta». |
| `hermes-backend/src/auto-replies/whatsapp-message-splitter.ts` | Conserva los saltos de línea de respuestas breves y listas numeradas. Mantiene el límite y la división de respuestas extensas. |
| `hermes-backend/src/conversation-engine/nous-hermes.transport.ts` | Indica a Nous que responda una consulta general de Black Friday en un mensaje breve, seleccione beneficios pertinentes y use la moneda de la oferta aprobada. Reconoce saludos acompañados de preguntas. |
| `hermes-backend/src/hermes/commercial-authority.service.ts` y `commercial-claims.ts` | Seleccionan la tarifa por moneda o país expresados en el mensaje; mantienen la moneda en el seguimiento; muestran ambas tarifas aprobadas si no hay señal de moneda o país; y retienen el precio si no hay tarifa vigente para la moneda solicitada. |
| Pruebas `*.spec.ts` y A7-D16 | Reproducen el incidente y verifican saludo, moneda, partes, lista, continuidad y selección de mercado con ofertas simuladas. |

## Ejemplo de comportamiento

**Antes:** el primer envío empezaba «Por lo que me comenta, Black Friday — Landing Page puede cubrir...» y enumeraba las diez prestaciones; el saludo aparecía al final. Un segundo envío repetía la promoción y el precio.

**Con una tarifa EUR aprobada y vigente en el CRM, `Yaupi` y el mensaje de `€ 80.00`:** «Hola, Yaupi. Con gusto le comparto los detalles. Nuestra promoción de Black Friday para Landing Page cuesta €80.00. Es una página de una sola sección para presentar su negocio y captar prospectos. ¿A qué actividad se dedica?» Se prepara **un solo mensaje** y **una sola generación**. Es un resultado de la prueba de regresión con tarifa simulada, no una plantilla fija impuesta al modelo.

**Consulta general sin moneda ni país, si ambas tarifas están aprobadas y vigentes:** «La promoción Black Friday — Landing Page cuesta €80.00 en España o USD $80.00 en Ecuador. Es una página de una sola sección para presentar su negocio y captar prospectos.» La respuesta no pregunta dónde será el proyecto.

## EUR frente a USD

El usuario indicó **EUR 80 para España y USD 80 para Ecuador**. Este PR no crea ni modifica tarifas. Nous toma la moneda mencionada por el cliente solo cuando existe una `PriceList` aprobada y vigente; si no la menciona, usa el país indicado o el contexto reciente. Sin país ni moneda, muestra ambas cifras solo si las dos tarifas existen y están activas. Si falta una tarifa vigente para la moneda solicitada, pide verificarla con el equipo comercial. Nunca convierte importes.

Los identificadores de anuncio por país se confirmaron posteriormente en `ProyectMD/prompt.md`; su asociación al mercado corresponde a un PR específico. El único ID configurado en este PR confirma la campaña, pero no el país del anuncio. **No se modificó la base productiva**.

## Validación

| Control | Resultado |
| --- | --- |
| Pruebas enfocadas de respuesta, divisor y transporte | 238/238 antes de los dos casos adicionales; tras la revisión, los tres casos afectados pasaron. |
| Suite unitaria completa del árbol final | 104 suites, **1684/1684** pruebas aprobadas. |
| A7-D16 aislado tras retirar la migración | 6 suites, **31/31** pruebas aprobadas; resumen en `hermes-backend/artifacts/nous-quality-no-catalog-write-20261031/summary.json`. |
| Build NestJS | Aprobado. |
| `prisma validate` | Aprobado con una URL local ficticia para la variable obligatoria; no conectó a una base real. |
| ESLint y Prettier en los seis archivos modificados | Aprobados. |
| `security:secrets` | Aprobado, 520 archivos revisados. |
| `git diff --check` | Aprobado antes del commit. |

Las pruebas cubren: contacto conocido y sin nombre válido; texto exacto de `€ 80.00`; anuncio Meta y consulta general sin Meta; continuidad de barbería y cambio a tienda online; diez prestaciones ordenadas y dominio concreto; precio aprobado e inactividad de la promoción; handoff, controles de entrega durable, división larga y una inferencia por turno; y comportamiento de `nous_hermes` y `gemini_direct`. Las pruebas existentes de STOP, opt-out, atribución, pagos, presupuestos, F3/F4 y aprendizaje permanecen en la suite aprobada.

## Riesgos y release

- La redacción del modelo puede variar fuera de las respuestas simuladas; el cierre comercial evita el prefijo duplicado y el fallback conserva la tarifa autorizada.
- Si en el futuro la lista de diez prestaciones supera el umbral de 520 caracteres, el divisor podría repartirla y perder parte del formato entre mensajes; la lista vigente cabe en un solo mensaje y se verifica con saltos de línea.
- Sin identificadores de anuncio por país, las consultas genéricas sin moneda ni país muestran ambas tarifas y sus mercados.

Revisar el PR contra `pilot/a7-d12-monitor-only-20261026`. El catálogo de España y el mapeo por Ad ID se tratan en el PR posterior. Conservar los artefactos A7-D16 locales como evidencia sintética.
