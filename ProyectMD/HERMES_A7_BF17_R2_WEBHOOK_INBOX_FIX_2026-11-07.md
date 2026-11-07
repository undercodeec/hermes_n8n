# Hermes 2.0 — A7-BF17-R2: corrección del Webhook Inbox

**Estado:** corrección funcional local validada y presentada para revisión. No desplegada.
**Fecha:** 2026-11-07
**Base:** `pilot/a7-d12-monitor-only-20261026` en `49a7f6adf3776e81fae9675f66b12ad48271dcf3`.
**Rama de corrección:** `fix/a7-bf17-r2-inbox-recovery-20261107`.

## Causa raíz

El [diagnóstico A7-BF17-R1](HERMES_A7_BF17_R1_INCIDENT_DIAGNOSIS_2026-11-07.md) documenta un evento `MESSAGE` sin `message.from` ni `contact.wa_id`. La versión servida invoca `.trim()` sobre un valor ausente y vuelve a reclamar indefinidamente ese `FAILED` porque trata todos los errores como recuperables. Al corte del diagnóstico, el evento seguía conservado y no tenía mensaje ni entrega vinculada. Los identificadores alternativos del payload no permiten inferir un número WhatsApp autorizado.

## Solución implementada

- `normalizeWhatsAppId()` acepta `unknown` y devuelve `null` para tipos o formatos inválidos antes de usar `.trim()`. Su salida válida sigue siendo el identificador internacional en dígitos sin `+`.
- El Inbox valida en runtime el JSON almacenado, ID de mensaje, remitente, contacto compatible, teléfono configurado, tipo y campos que usa cada ruta. Un `message.from` válido permite construir un contacto mínimo cuando Meta omite el arreglo opcional `contacts`; un contacto presente pero incompatible se conserva para cuarentena, sin sustituir `wa_id` por otros campos.
- Los callbacks firmados con eventos accionables malformados quedan guardados con identidad durable. Si falta un ID de mensaje utilizable, la clave SHA-256 incorpora contenido y posición dentro del callback para deduplicar reentregas iguales sin colapsar dos eventos idénticos del mismo lote.
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
| `hermes-backend/src/webhook/webhook-inbox-recovery.spec.ts` | Payloads sintéticos, deduplicación, tipos inválidos, contacto opcional, `STATUS`, backoff y ausencia de nuevos reclamos. |
| `hermes-backend/src/payments/payments.service.ts` y `.spec.ts` | Idempotencia de comprobantes durante la recuperación. |
| `hermes-backend/test/advertising-flow.integration-spec.ts` | Webhook firmado R1 sintético en PostgreSQL y mensaje válido sin `contacts`. |

## Verificación local

| Gate | Resultado |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund`; `npx prisma generate` | PASS |
| Prisma validate con URL sintética local | PASS |
| TypeScript `tsc --noEmit`; build NestJS | PASS |
| ESLint sin `--fix`; Prettier `--check`; `git diff --check` | PASS |
| Pruebas focalizadas de normalizador, webhook y pagos | 4 suites, 85 PASS sobre el estado final |
| Unitarias completas | 113 suites, 1.937 PASS sobre el estado final |
| Gate de integración con PostgreSQL y Redis desechables en loopback | 18 suites, 190 PASS, 0 FAIL, 1 skip permitido por el gate |
| A7-D16 E2E aislado | 6 suites, 31 PASS |
| Escaneo de secretos | PASS, 574 archivos examinados |
| `npm audit --omit=dev --audit-level=high` | PASS, 0 vulnerabilidades reportadas |

La integración comprueba que el evento R1 sintético firmado queda `FAILED` permanente, conserva el payload, no se vuelve a reclamar y no crea mensaje ni respuesta. También confirma que un mensaje firmado válido sin `contacts` crea un solo contacto, mensaje y lead y conserva el encolado normal. Las suites existentes cubren scanners concurrentes, reinicios, atribución, handoff, STOP/opt-out, comprobantes y entregas. La única prueba omitida por el gate de integración corresponde al BFF web v2, fuera de este backend.

## Recuperación operativa pendiente

Este cambio local no altera el evento productivo. Antes de intervenir, un operador autorizado debe verificar identidad y hash del payload, estado, outcome, contador, lease y ausencia de claim o trabajo en vuelo; confirmar que no existen mensaje ni entrega asociados; y reproducir la clasificación con fixture sintética. Tras aprobar un despliegue separado, el scanner corregido puede clasificar el antiguo `FAILED/processing_error` al vencer su lease. Una cuarentena manual alternativa requiere transacción, bloqueo y comparación condicional de todos los campos observados, modificación exclusiva de outcome/lease, auditoría y verificación de que los intentos cesan. No se debe reinyectar el webhook ni adivinar el remitente.

## Estado y riesgos pendientes

La corrección está basada en el HEAD piloto que ya incluye Black Friday. La imagen GHCR A7-BF16 es inmutable y no contiene este parche. Según el último [preflight público](HERMES_A7_BF17_PRODUCTION_PREFLIGHT_2026-11-07.md), producción seguía en un commit anterior; este informe no afirma haber repetido la lectura productiva. El evento continuará fallando hasta una intervención autorizada.

La procedencia de los identificadores alternativos aún no se conoce. La huella de eventos sin ID depende de su JSON y posición; si el proveedor reagrupa el lote, podría aparecer otra fila en cuarentena. La clasificación evita un envío sin destino autorizado, pero el mensaje afectado requiere revisión humana. También siguen pendientes backup reciente y restauración aislada, reconciliación de `current.json`, evaluación del incidente de credenciales por el procedimiento de seguridad correspondiente, nuevo preflight y autorización de despliegue. Ningún test local sustituye una verificación productiva controlada.

**Próximo paso:** revisión del PR funcional contra la rama piloto. No fusionar ni desplegar automáticamente. Después de integrar una versión aprobada, construir una nueva imagen desde el commit integrado definitivo y ejecutar los gates operativos separados.
