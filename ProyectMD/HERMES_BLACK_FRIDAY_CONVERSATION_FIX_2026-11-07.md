# Hermes 2.0 — corrección conversacional de Black Friday (2026-11-07)

**Estado:** implementación local validada; PR #15 abierto para revisión.

## Causa raíz y reglas

La intención general tenía reconocimiento incompleto, y la composición detallada dependía de una atribución válida de Meta Ads. La instrucción de Nous favorecía una respuesta breve de una sola parte. El formateador podía distribuir la información en tres partes y unir la pregunta a la lista cuando F3 permitía solo dos.

Ahora la intención explícita de una promoción Black Friday activa selecciona una sola oferta con precio autorizado en el CRM, sin exigir Meta Ads. El backend construye una primera parte con saludo local, importe y diez prestaciones del `scope` promocional, y una segunda parte física con una pregunta comercial pertinente. Se preparan mediante `AutomatedDelivery.prepareBatch`. Si F3 permite una sola parte, entrega únicamente la información completa. La consulta concreta sobre hosting o soporte conserva la respuesta breve. La lógica existente de STOP, opt-out, handoff, ventana de WhatsApp, idempotencia y reintentos no se modificó.

El saludo usa `America/Guayaquil` por defecto: 00:00–11:59 «Buenos días», 12:00–18:59 «Buenas tardes», 19:00–23:59 «Buenas noches». El formateador acepta una zona horaria validada; hoy el flujo de respuesta no dispone de un campo confiable de zona del cliente, por lo que usa Guayaquil. El tratamiento se obtiene de `customer-salutation.ts` y se limita a la primera respuesta.

## Archivos y pruebas

- `hermes-backend/src/hermes/black-friday-landing.ts` y su spec: variantes orgánicas, monto escrito en palabras y exclusión de presupuesto u otro servicio.
- `hermes-backend/src/auto-replies/black-friday-visual-response.ts` y su spec: dos partes, diez ítems con emojis y saltos de línea, saludo determinista, nombre seguro y pregunta sin repetición.
- `hermes-backend/src/auto-replies/auto-reply.service.ts` y su spec: selección inequívoca de oferta CRM, composición para Gemini y Nous, `prepareBatch` con índices 0 y 1, dos envíos Meta simulados y límites F3.
- `hermes-backend/src/conversation-engine/nous-hermes.transport.ts` y su spec: instrucción coherente con la composición determinista.

Los casos existentes siguen cubriendo promoción inactiva, consultas específicas, moneda/mercado, STOP, opt-out, handoff y reintento de entregas parciales. La integración aislada ejecutó también `automated-delivery.integration-spec.ts`.

## Evidencia de gates locales

| Gate | Resultado |
| --- | --- |
| TypeScript `tsc --noEmit --incremental false` | Aprobado |
| `npm run build` | Aprobado |
| ESLint de todos los archivos TS | Aprobado |
| `prisma validate` con URL local sintética | Aprobado |
| Escaneo de secretos | Aprobado; 546 archivos |
| Unitarias | 112 suites, 1892/1892 pruebas |
| Suites afectadas tras ajuste final | 3 suites, 284/284 pruebas |
| Comerciales | 4 suites, 148/148 pruebas |
| Integración aislada | 18 suites, 188/188 pruebas ejecutadas, 1 omitida por el gate |
| A7-D16 | 6 suites, 31/31 pruebas |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilidades productivas |

La prueba omitida pertenece a `advertising-flow.integration-spec.ts`: registro de intención web BFF v2. El gate la declara permitida y no afecta este flujo. Las pruebas no hicieron envíos reales por Meta ni utilizaron PostgreSQL productivo. La revisión independiente detectó y permitió corregir un fixture TypeScript incompleto, una variante orgánica de «$80.00», la pérdida de un salto de párrafo, las preguntas solo de precio y las preguntas previas sin tildes. Los gates finales se repitieron tras esas correcciones.

## Ejemplo de partes preparadas

**Parte 0 — información:**

> Buenos días. Con gusto le comparto la información de nuestra promoción *Black Friday por USD $80*.
>
> 🎯 Captación de clientes potenciales  
> 🖥️ Landing Page de una sola sección  
> 📱 Diseño responsive, optimizado para celulares  
> 💬 Botón flotante de WhatsApp y llamada directa  
> 📝 Formulario de contacto o captura de prospectos  
> ⭐ Sección de beneficios del servicio o producto  
> 🌍 Dominio .com y hosting básico por 1 año  
> 📧 5 correos corporativos  
> 🔍 SEO técnico base  
> 🛠️ *1 año de soporte técnico posterior a la entrega*

**Parte 1 — entrega independiente:**

> Cuénteme, por favor, ¿qué tipo de proyecto o solución tiene en mente?

La prueba de servicio comprueba dos registros de `prepareBatch`, diez líneas de prestaciones en la parte 0, pregunta en la parte 1 y dos operaciones de envío simuladas. Sin atribución Meta, la misma intención explícita activa este formato cuando el CRM autoriza la oferta. No se cambió ninguna tarifa ni se afirma IVA incluido sin respaldo.

## Riesgos y publicación posterior

La promoción depende de que el CRM entregue exactamente una oferta activa con precio y un `scope` de diez prestaciones; si hay varias tarifas aplicables o faltan datos, el formateador no fuerza una moneda. Una zona horaria del cliente solo puede incorporarse cuando exista una fuente validada. El despliegue, los envíos Meta reales y la observación de conversaciones productivas quedan fuera de esta tarea local.

Tras aprobar y fusionar el PR, seguir el pipeline habitual de imagen validada y despliegue supervisado. Verificar una conversación de prueba autorizada y los registros de `AutomatedDelivery` para ambas partes. Ante una regresión, volver a la imagen previamente validada y revisar las entregas persistidas antes de cualquier reintento; no editar PriceList ni ejecutar migraciones como parte del rollback.

**Commit de implementación:** `953eb4ef1689bf6a02152e464939ed51e39172a1`  
**PR contra `pilot/a7-d12-monitor-only-20261026`:** https://github.com/undercodeec/hermes_n8n/pull/15

**Dictamen:** `HERMES_BLACK_FRIDAY_CONVERSATION_FIX_READY_FOR_REVIEW`
