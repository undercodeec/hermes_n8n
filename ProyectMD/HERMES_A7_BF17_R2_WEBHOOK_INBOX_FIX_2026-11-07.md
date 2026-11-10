# Hermes 2.0 — A7-BF17-R2: corrección del Webhook Inbox

> **Acta histórica.** Resultados originales conservados; no acredita producción actual. [Estado vigente](estado-proyecto.md). Los documentos PR #16 enlazados son evidencia remota no integrada.

**Estado:** revisión técnica final validada para el PR #17. No fusionada ni desplegada.
**Fecha:** 2026-11-07
**Base:** `pilot/a7-d12-monitor-only-20261026` en `49a7f6adf3776e81fae9675f66b12ad48271dcf3`.
**Rama de corrección:** `fix/a7-bf17-r2-inbox-recovery-20261107`.

## Causa raíz

El [diagnóstico A7-BF17-R1](https://github.com/undercodeec/hermes_n8n/blob/5034fac19dcdbe49562a5b5cec068d3de0f9f60d/ProyectMD/HERMES_A7_BF17_R1_INCIDENT_DIAGNOSIS_2026-11-07.md) documenta un evento `MESSAGE` sin `message.from` ni `contact.wa_id`. La versión servida invoca `.trim()` sobre un valor ausente y vuelve a reclamar indefinidamente ese `FAILED` porque trata todos los errores como recuperables. Al corte del diagnóstico, el evento seguía conservado y no tenía mensaje ni entrega vinculada. Los identificadores alternativos del payload no permiten inferir un número WhatsApp autorizado.

## Solución implementada

- `normalizeWhatsAppId()` acepta `unknown` y devuelve `null` para tipos o formatos inválidos antes de usar `.trim()`. Su salida válida sigue siendo el identificador internacional en dígitos sin `+`.
- El Inbox valida en runtime el JSON almacenado, ID de mensaje, remitente, contacto compatible, teléfono configurado, tipo y campos que usa cada ruta. Un `message.from` válido permite construir un contacto mínimo cuando Meta omite el arreglo opcional `contacts`; un contacto presente pero incompatible se conserva para cuarentena, sin sustituir `wa_id` por otros campos.
- Los callbacks firmados con eventos accionables malformados quedan guardados con identidad durable. Si falta un ID de mensaje utilizable, la clave SHA-256 incorpora contenido y posición dentro del callback para deduplicar reentregas iguales sin colapsar dos eventos idénticos del mismo lote.
- Si una reentrega trae el mismo ID y un payload distinto, `skipDuplicates` conserva el evento original y el Inbox agrega un `REDELIVERY_CONFLICT` con clave SHA-256 estable y el payload nuevo completo. El scanner lo clasifica como `PERMANENT_INVALID_PAYLOAD:REDELIVERY_CONFLICT`; una repetición idéntica no crea más filas. El mensaje corregido exige cotejo y resolución humana: no se libera automáticamente la cuarentena ni se envía una respuesta.
- Un error estructural queda `FAILED` con `outcome=PERMANENT_INVALID_PAYLOAD:<causa>` y `leaseUntil=NULL`. El payload, la clave, las fechas y el contador permanecen intactos. El scanner exige un outcome recuperable además de un lease vencido al seleccionar y reclamar un `FAILED`; una cuarentena no se reactiva aunque otro proceso le ponga un lease vencido.
- Los errores transitorios usan `RETRYABLE_PROCESSING_ERROR` con backoff; la atribución recuperable usa `RETRYABLE_ATTRIBUTION_ERROR`. Se siguen reconociendo los outcomes legados `processing_error` y `attribution_retry`, así como los `PROCESSING` abandonados. Las transiciones mantienen el guard de `claimToken`.
- La recuperación de un comprobante ya registrado sigue tratándolo como comprobante aunque el pago haya salido de estados abiertos. Las claves únicas, el job ID y el ledger de entregas siguen protegiendo la ruta reanudada. No se modificaron reglas de STOP, opt-out, handoff humano ni ventana WhatsApp.

El modelo Prisma existente admite estos códigos en `outcome`; no hay migración.

## Archivos de código y pruebas

| Ruta | Cambio |
| --- | --- |
| `hermes-backend/src/campaigns/phone-normalizer.ts` y `.spec.ts` | Normalización segura y casos de tipos/formatos no confiables. |
| `hermes-backend/src/webhook/webhook-inbox-validation.ts` | Validación estructural de mensajes y estados. |
| `hermes-backend/src/webhook/webhook.service.ts` y `.spec.ts` | Aceptación durable, cuarentena, selección recuperable, leases y reanudación. |
| `hermes-backend/src/webhook/webhook-inbox-recovery.spec.ts` | Payloads sintéticos, deduplicación, reentrega corregida, tipos Meta válidos e inválidos, contacto opcional, estados, backoff y ausencia de nuevos reclamos. |
| `hermes-backend/src/payments/payments.service.ts` y `.spec.ts` | Idempotencia de comprobantes durante la recuperación. |
| `hermes-backend/test/advertising-flow.integration-spec.ts` | Webhook firmado R1 sintético, reentrega corregida y fallos tras crear contacto o conversación en PostgreSQL aislado. |

## Verificación local

| Gate | Resultado |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund`; `npx prisma generate` | PASS |
| Prisma validate con URL sintética local | PASS |
| TypeScript `tsc --noEmit`; build NestJS | PASS |
| ESLint sin `--fix`; Prettier `--check`; `git diff --check` | PASS |
| Pruebas focalizadas de normalizador, webhook y pagos | 4 suites, 97 PASS sobre el estado final |
| Unitarias completas | 113 suites, 1.949 PASS sobre el estado final |
| Gate de integración con PostgreSQL y Redis desechables en loopback | 18 suites, 192 PASS, 0 FAIL, 1 skip permitido por el gate |
| A7-D16 E2E aislado | 6 suites, 31 PASS |
| Escaneo de secretos | PASS, 575 archivos examinados |
| `npm audit --omit=dev --audit-level=high` | PASS, 0 vulnerabilidades reportadas |

La integración comprueba que el evento R1 sintético firmado queda `FAILED` permanente, conserva el payload, no se vuelve a reclamar y no crea mensaje ni respuesta. También confirma que un mensaje firmado válido sin `contacts` crea un solo contacto, mensaje y lead y conserva el encolado normal. Las suites existentes cubren scanners concurrentes, reinicios, atribución, handoff, STOP/opt-out, comprobantes y entregas. La única prueba omitida por el gate de integración corresponde al BFF web v2, fuera de este backend.

## Revisión final del PR #17

El preflight directo en GitHub confirmó el HEAD inicial `1377d92ad009b9c643fa7bd0f6d2f0c05c60f32c`, base piloto `49a7f6adf3776e81fae9675f66b12ad48271dcf3`, PR abierto como borrador, sin conflictos y con diez archivos. Se revisó el patch completo. No había reviews, hilos, checks de commit ni ejecuciones de GitHub Actions vinculadas al HEAD inicial. Este informe requiere nueva comprobación de GitHub tras publicar el commit de revisión.

La revisión detectó que `createMany(skipDuplicates)` descartaba sin rastro una reentrega corregida con el mismo ID de un mensaje previamente puesto en cuarentena. La corrección conserva ambos payloads mediante una fila de conflicto estable. La prueba unitaria repite la reentrega y confirma que sólo quedan dos filas, que el original no cambia y que ningún mensaje se procesa. La prueba firmada en PostgreSQL confirma la misma cuarentena sin contacto ni mensaje nuevo. Un operador debe cotejar origen, firma y datos y decidir una recuperación manual controlada; este PR no reinyecta ni desbloquea el evento.

Se probaron texto, imagen, audio, documento, video, ubicación, reacción, botón interactivo, lista, estados `delivered/read/failed` y `contacts` ausente. También se verifican variantes incompatibles o incompletas y un evento legado `FAILED/processing_error` con 5.276 intentos: pasa a cuarentena permanente en el intento 5.277 y los scans posteriores no aumentan el contador, incluso con lease alterado. Los outcomes históricos `processing_error` y `attribution_retry` siguen en la lista recuperable.

La integración inyecta fallos después de crear contacto y conversación; las pruebas existentes cubren reanudación tras persistir mensaje, atribución, comprobante, preparación de respuesta y llamada Meta. Contacto, conversación, lead, mensaje, tarea y lote mantienen sus claves y guards de idempotencia. Una respuesta Meta confirmada con persistencia fallida queda ambigua para conciliación: no se garantiza repetir con seguridad una entrega externa. La primera corrida de la integración de revisión encontró una carrera del helper de prueba con el scan asíncrono del controlador; se aisló esa programación sólo en los casos de inyección y se repitió el gate completo con 192 aprobadas, 0 fallidas y la omisión prevista.

La rama piloto ya contiene Black Friday. El diff del PR no cambia las reglas comerciales ni añade migraciones. La suite completa aprobó las pruebas de detección, selección CRM, precio USD 80, diez prestaciones, saludo, dos entregas físicas, STOP, handoff y ledger de entregas. La compatibilidad queda acreditada por pruebas locales; no implica un ensayo en producción.

## Recuperación operativa pendiente

Este cambio local no altera el evento productivo. Antes de intervenir, un operador autorizado debe verificar identidad y hash del payload, estado, outcome, contador, lease y ausencia de claim o trabajo en vuelo; confirmar que no existen mensaje ni entrega asociados; y reproducir la clasificación con fixture sintética. Tras aprobar un despliegue separado, el scanner corregido puede clasificar el antiguo `FAILED/processing_error` al vencer su lease. Una cuarentena manual alternativa requiere transacción, bloqueo y comparación condicional de todos los campos observados, modificación exclusiva de outcome/lease, auditoría y verificación de que los intentos cesan. No se debe reinyectar el webhook ni adivinar el remitente.

## Estado y riesgos pendientes

La corrección está basada en el HEAD piloto que ya incluye Black Friday. La imagen GHCR A7-BF16 es inmutable y no contiene este parche. Según el último [preflight público](https://github.com/undercodeec/hermes_n8n/blob/5034fac19dcdbe49562a5b5cec068d3de0f9f60d/ProyectMD/HERMES_A7_BF17_PRODUCTION_PREFLIGHT_2026-11-07.md), producción seguía en un commit anterior; este informe no afirma haber repetido la lectura productiva. El evento continuará fallando hasta una intervención autorizada.

La procedencia de los identificadores alternativos aún no se conoce. La huella de eventos sin ID depende de su JSON y posición; si el proveedor reagrupa el lote, podría aparecer otra fila en cuarentena. La clasificación evita un envío sin destino autorizado, pero el mensaje afectado requiere revisión humana. También siguen pendientes backup reciente y restauración aislada, reconciliación de `current.json`, evaluación del incidente de credenciales por el procedimiento de seguridad correspondiente, nuevo preflight y autorización de despliegue. Ningún test local sustituye una verificación productiva controlada.

**Próximo paso:** revisión del PR funcional contra la rama piloto. No fusionar ni desplegar automáticamente. Después de integrar una versión aprobada, construir una nueva imagen desde el commit integrado definitivo y ejecutar los gates operativos separados.
