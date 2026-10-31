# Corrección de calidad conversacional de Nous — 31 de octubre de 2026

## Estado y procedencia

- Base productiva: `871d332ada0eb2dae22e9c39be367734090c3e76`.
- Rama aislada: `fix/nous-conversational-quality-20261031`.
- PR: https://github.com/undercodeec/hermes_n8n/pull/2 (base `pilot/a7-d12-monitor-only-20261026`).
- Commit de implementación: `f24a915046493fd93685034afc8e32fb86ffcf62`.
- Tree SHA de implementación: `24f8792fb1d59f70021b84dbb237de2c47bec4d4`.
- Sin integración ni despliegue. Ningún ensayo usó WhatsApp real.

## Causa raíz

`AutoReplyService` exigía que la respuesta del modelo contuviera el nombre **exacto** del plan para considerarla una recomendación. Ante la consulta general del anuncio, aunque el modelo ya explicaba la landing y el precio, el backend anteponía `recommended.scope` completo con las diez prestaciones. Al cambiar el texto, se descartaban los `replyParts` originales; `splitWhatsAppMessage()` dividía la oración larga por el umbral de 520 caracteres. Los dos envíos observados podían proceder de **una sola generación** y una sola preparación de entrega, sin necesitar una segunda inferencia.

Había dos fallos adicionales: `polishInitialGreeting()` solo reconocía saludos sin consulta y se ejecutaba antes del último fallback comercial; y el divisor convertía los saltos de línea de «¿Qué incluye?» en espacios. La segunda revisión detectó también que `¡Hola!` en la respuesta del motor podía duplicar el saludo y que una consulta general sin atribución Meta podía conservar dos `replyParts` de Nous.

## Cambios

| Archivo | Cambio |
| --- | --- |
| `hermes-backend/src/auto-replies/auto-reply.service.ts` | Evita anteponer la recomendación genérica a la oferta Black Friday; reduce el fallback general a producto, precio y un beneficio autorizado; conserva una respuesta útil del modelo; une partes cortas de consultas generales; aplica el saludo al texto final; aclara euros frente a la moneda aprobada sin convertir importes. Las recomendaciones ordinarias usan un fragmento pertinente del alcance y ya no abren con «Por lo que me comenta». |
| `hermes-backend/src/auto-replies/whatsapp-message-splitter.ts` | Conserva los saltos de línea de respuestas breves y listas numeradas. Mantiene el límite y la división de respuestas extensas. |
| `hermes-backend/src/conversation-engine/nous-hermes.transport.ts` | Indica a Nous que responda una consulta general de Black Friday en un mensaje breve, seleccione beneficios pertinentes, reserve las diez prestaciones para una solicitud de detalle y trate la discrepancia de moneda. Reconoce saludos acompañados de preguntas. |
| Tres archivos `*.spec.ts` correspondientes | Reproducen el incidente real y verifican saludo, moneda, partes, lista, continuidad y el texto de instrucciones. |

## Ejemplo de comportamiento

**Antes:** el primer envío empezaba «Por lo que me comenta, Black Friday — Landing Page puede cubrir...» y enumeraba las diez prestaciones; el saludo aparecía al final. Un segundo envío repetía la promoción y el precio.

**Después, con `Yaupi` en el CRM:** «Hola, Yaupi. Con gusto le comparto los detalles. Nuestra promoción de Black Friday para Landing Page tiene un precio de 80.00 USD. Es una página de una sola sección para presentar su negocio y captar prospectos. Su mensaje menciona euros; la tarifa autorizada está en USD y conviene confirmar la diferencia con el equipo comercial. ¿A qué actividad se dedica?» Se prepara **un solo mensaje** y **una sola generación**. Es un resultado de la prueba de regresión, no una plantilla fija impuesta al modelo.

## EUR frente a USD

El mensaje precargado de Meta Ads dice `€ 80.00`; la oferta activa aprobada por Commercial Authority dice `USD 80.00`. El sistema no los trata como equivalentes ni convierte moneda. Cuando el cliente menciona euros y la oferta activa autoriza otra moneda, la respuesta indica la discrepancia y remite su confirmación al equipo comercial. **Recomendación operativa:** revisar el texto y la moneda configurados en el anuncio y en el mensaje precargado de Meta Ads antes del release. No se modificaron precios, monedas ni registros de PostgreSQL productivo.

## Validación

| Control | Resultado |
| --- | --- |
| Pruebas enfocadas de respuesta, divisor y transporte | 238/238 antes de los dos casos adicionales; tras la revisión, los tres casos afectados pasaron. |
| Suite unitaria completa del árbol final | 104 suites, **1674/1674** pruebas aprobadas. |
| A7-D16 aislado del árbol final | 6 suites, **31/31** pruebas aprobadas; resumen en `hermes-backend/artifacts/nous-quality-reviewed-20261031/summary.json`. |
| Build NestJS | Aprobado. |
| `prisma validate` | Aprobado con una URL local ficticia para la variable obligatoria; no conectó a una base real. |
| ESLint y Prettier en los seis archivos modificados | Aprobados. |
| `security:secrets` | Aprobado, 520 archivos revisados. |
| `git diff --check` | Aprobado antes del commit. |

Las pruebas cubren: contacto conocido y sin nombre válido; texto exacto de `€ 80.00`; anuncio Meta y consulta general sin Meta; continuidad de barbería y cambio a tienda online; diez prestaciones ordenadas y dominio concreto; precio aprobado e inactividad de la promoción; handoff, controles de entrega durable, división larga y una inferencia por turno; y comportamiento de `nous_hermes` y `gemini_direct`. Las pruebas existentes de STOP, opt-out, atribución, pagos, presupuestos, F3/F4 y aprendizaje permanecen en la suite aprobada.

## Riesgos y release

- La redacción del modelo puede variar fuera de las respuestas simuladas; el cierre comercial evita el prefijo duplicado y el fallback conserva la tarifa autorizada.
- Si en el futuro la lista de diez prestaciones supera el umbral de 520 caracteres, el divisor podría repartirla y perder parte del formato entre mensajes; la lista vigente cabe en un solo mensaje y se verifica con saltos de línea.
- El texto actual del anuncio con euros requiere revisión comercial para evitar nuevas consultas con moneda contradictoria.

Revisar el PR contra `pilot/a7-d12-monitor-only-20261026`, corregir el anuncio de Meta y desplegar solo después de la revisión humana. Conservar los artefactos A7-D16 locales como evidencia sintética.
