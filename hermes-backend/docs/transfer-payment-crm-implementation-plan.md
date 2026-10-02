# Plan de implementación: transferencias bancarias en Hermes CRM

**Estado:** implementación local preparada; pendiente de configuración, migración aplicada y prueba con Meta
**Última actualización:** 2026-10-02
**Repositorios implicados:** `Hermes/hermes-backend` y `undercodeec_nextjs`.

**Avance 2026-10-02:** se añadieron esquema y migración, cuentas bancarias cifradas, política de intención, detección de mensajes comprobante, tarea y acciones de validación, y la UI en Inbox. Compilan ambos repositorios y pasan las pruebas automatizadas del backend. El flag permanece apagado. Antes de activar: backup verificable, aplicar migración en el entorno elegido, configurar clave de cifrado y cuenta bancaria, y hacer el recorrido real con Meta y un operador.

## 1. Propósito

Implementar un flujo de transferencias bancarias iniciado desde conversaciones de WhatsApp. Hermes debe entregar datos bancarios únicamente ante una intención de compra real, detectar el comprobante enviado por el cliente y crear una tarea de validación para que un operador apruebe o rechace el pago desde el CRM.

El comprobante no se copiará ni se guardará como archivo propio. Permanecerá como el mensaje multimedia original de WhatsApp y será visible exclusivamente dentro del chat Inbox de la conversación correspondiente. Para mostrar una imagen o PDF, el backend obtiene temporalmente los bytes desde Meta mediante una ruta autenticada de Inbox y los entrega en línea, sin conservarlos. No se ofrece una función de descarga, storage, URLs firmadas, visor separado ni pantalla de pagos.

La fuente de verdad será Hermes. UnderCodeEC Next.js será la interfaz administrativa y accederá al backend mediante el proxy actual `/api/hermes/*`.

### Resultado de negocio

1. Administración puede crear, editar, priorizar y desactivar cuentas bancarias.
2. Una solicitud inequívoca de datos de transferencia eleva el lead a máxima prioridad y envía una cuenta autorizada.
3. Una imagen o PDF recibido como comprobante queda asociado por su mensaje al lead, genera una tarea y se revisa en el Inbox de esa conversación.
4. Hermes mantiene una conversación veraz: confirma recepción y validación pendiente, nunca una aprobación inexistente.
5. Solo la aprobación humana registra el lead como `WON` y emite una conversión comercial.

## 2. Decisión fundamental: voucher recibido no equivale a venta aprobada

No usar `WON` al recibir el comprobante. Un voucher puede ser ilegible, duplicado, falso o no corresponder al monto esperado. Además, Hermes ya trata el cambio a `WON` como un hito comercial inmutable y puede emitir `CONTRACT_WON` para publicidad.

| Estado visible | Estado técnico | Significado | ¿Cuenta como venta? |
|---|---|---|---|
| Pago solicitado | `PAYMENT_PENDING` | El cliente pidió datos y Hermes los envió. | No |
| Ganado pendiente de validación | `PAYMENT_REVIEW` | Llegó un comprobante y un operador debe validarlo desde Inbox. | No |
| Ganado | `WON` | El operador confirmó el pago. | Sí |

Esta decisión satisface la prioridad comercial solicitada sin registrar ingresos o conversiones antes de una validación real.

## 3. Alcance

### Incluido

- CRUD administrativo de cuentas bancarias.
- Regla de intención real para pedir datos de transferencia.
- Selección determinística de cuenta y envío de instrucciones.
- Registro de intento de pago, referencia al mensaje comprobante, tarea y auditoría.
- Detección de imágenes y documentos de WhatsApp como comprobantes candidatos.
- Revisión y decisión humana desde el chat Inbox de la conversación correspondiente.
- Cambio controlado a `WON`, eventos y mensajes posteriores.
- Pruebas unitarias, de integración y recorrido manual.

### Fuera de alcance inicial

- Descargar el media al recibirlo, guardarlo en storage propio o exponer un enlace de descarga permanente.
- Visor de vouchers, página de pagos, bandeja independiente o panel de archivos de comprobantes.
- Conciliación automática con APIs de bancos.
- OCR usado como decisión de fraude o aprobación.
- Cambios al checkout web/PayPhone, SRI o facturación.
- Reutilizar `POST /api/upload-voucher` de UnderCodeEC: es un flujo de checkout diferente y sirve archivos desde un directorio público.

OCR podrá añadirse después como ayuda visual. La aprobación seguirá siendo humana.

## 4. Arquitectura y responsabilidades

~~~text
Cliente WhatsApp
   │
   ▼
Webhook Meta ──> Hermes: Message + Conversation
                    │
                    ├─> TransferIntentPolicy
                    │       └─> PaymentService -> instrucciones autorizadas
                    │
                    └─> PaymentProofDetectionService
                            └─> referencia al Message + tarea de revisión
                                        │
                                        ▼
                         Inbox CRM de esa conversación
                                        │
                                        ▼
                         acción protegida de aprobar/rechazar
~~~

### Reglas de autoridad

- El LLM puede sugerir intención o tono, pero no puede seleccionar cuentas, cambiar estados, confirmar pagos ni marcar ventas.
- `PaymentService` obtiene una cuenta activa desde la base y compone el mensaje con plantilla de servidor.
- Los números completos de cuenta, teléfonos e identificaciones no se incluyen en prompts de IA, logs de aplicación ni analítica.
- El CRM llama a Hermes con JWT existente; la interfaz abre el comprobante dentro del Inbox ya autorizado, sin storage ni descarga propia.

## 5. Máquina de estados

### 5.1 Etapas del lead

Ampliar `LeadStage` en `prisma/schema.prisma`:

~~~text
NEW -> CONTACTED -> QUALIFIED -> PROPOSAL -> NEGOTIATION
                                          └-> PAYMENT_PENDING -> PAYMENT_REVIEW -> WON
                                                                    │
                                                                    └-> PAYMENT_PENDING / NEGOTIATION / LOST
~~~

Transiciones permitidas:

| Desde | Hacia | Quién puede hacerlo |
|---|---|---|
| `QUALIFIED`, `PROPOSAL`, `NEGOTIATION` | `PAYMENT_PENDING` | Política de transferencia después de crear el intento |
| `PAYMENT_PENDING` | `PAYMENT_REVIEW` | Servicio de ingestión de proof |
| `PAYMENT_PENDING` | `NEGOTIATION`, `LOST` | Operador |
| `PAYMENT_REVIEW` | `WON` | Solo `PaymentService.approve` |
| `PAYMENT_REVIEW` | `PAYMENT_PENDING`, `NEGOTIATION`, `LOST` | Solo flujo de rechazo autorizado |

No exponer `PAYMENT_REVIEW -> WON` como un arrastre libre en el Kanban. El backend debe rechazar un `PUT /leads/:id` que intente cerrar una venta sin una transferencia aprobada.

### 5.2 Estado de transferencia

Crear `TransferPaymentStatus`:

~~~text
INSTRUCTIONS_PREPARED
INSTRUCTIONS_SENT
PROOF_RECEIVED
UNDER_REVIEW
APPROVED
REJECTED
CANCELLED
EXPIRED
~~~

Reglas:

- Solo un intento abierto por combinación de lead y conversación.
- Cada mensaje entrante que desencadena una operación lleva una clave de idempotencia.
- Se pueden asociar varios mensajes comprobante al mismo intento; se revisan directamente en Inbox y se preserva el mensaje seleccionado para la decisión final.
- Los estados `APPROVED` y `REJECTED` son finales. Cualquier corrección posterior necesita una acción administrativa nueva, nunca una actualización silenciosa.

## 6. Criterio de intención de compra real

Crear la intención interna `solicitar_transferencia`. No utilizar por sí sola la intención actual `pago`, porque esa intención genérica sirve para calificación y produce falsos positivos.

### Condiciones obligatorias

La política debe examinar el último mensaje entrante y exigir todas estas condiciones:

1. Petición explícita de datos bancarios o transferencia.
2. Afirmación de pago inmediato, no una consulta teórica.
3. Servicio/producto definido y propuesta, cotización o monto vigente en el lead.
4. Lead abierto y sin transferencia ya aprobada.
5. Existe una cuenta bancaria activa para la moneda del pago.

| Texto del cliente | Resultado |
|---|---|
| “Pásame los datos para realizar la transferencia.” | Activa si existe contexto comercial válido. |
| “¿A qué cuenta les pago el anticipo?” | Activa si monto/anticipo están definidos. |
| “Voy a transferir hoy, dame los datos bancarios.” | Activa si hay oferta vigente. |
| “¿Aceptan transferencia?” | No activa: consulta general. |
| “¿Cuál es el precio?” | No activa: no solicita pagar. |
| “No quiero transferir.” | No activa: negación explícita. |
| “Ya transferí” sin intento abierto | No crea venta; pedir comprobante o atención humana. |

### Diseño técnico recomendado

Crear `TransferIntentPolicy` con normalización de español, patrones positivos y de negación, y una comprobación de contexto persistido. Debe devolver:

~~~ts
{ approved: boolean, reason: string, evidence: string, policyVersion: string }
~~~

El resultado del modelo será auxiliar; la política siempre vuelve a comprobar el texto literal del cliente. La evidencia, ID de mensaje y versión de regla se guardan en auditoría.

Si se aprueba:

1. bloquear por `contactId`/lead para evitar carreras;
2. seleccionar cuenta activa de la moneda correcta por prioridad;
3. crear o recuperar el `TransferPayment` idempotente;
4. tomar snapshot de los datos enviados;
5. pasar lead a `PAYMENT_PENDING`;
6. enviar mensaje de instrucciones y guardar `instructionsMessageId`;
7. crear una tarea de seguimiento si se requiere.

Si no se aprueba, Hermes conserva su flujo de conversación comercial normal.

## 7. Modelo de datos propuesto

No almacenar esta información dentro de `Lead.metadata`. Usar entidades relacionales auditables.

### 7.1 BankAccount

| Campo | Descripción |
|---|---|
| `id` | UUID interno. |
| `label` | Nombre operativo, por ejemplo “Cuenta principal USD”. |
| `bankName` | Banco receptor. |
| `accountHolder` | Titular. |
| `holderIdentification` | RUC/cédula si es necesario para el pago. |
| `accountType` | Ahorros, corriente u otro enum. |
| `accountNumberEncrypted` | Número cifrado en reposo. |
| `accountNumberLast4` | Últimos cuatro dígitos para listados. |
| `currency` | ISO 4217; inicialmente USD. |
| `instructions` | Referencia/instrucciones aprobadas. |
| `priority` | Menor valor = primera opción. |
| `isActive` | Baja lógica. |
| `createdByUserId`, `updatedByUserId` | Auditoría administrativa. |

No eliminar físicamente una cuenta ya usada. Desactivarla y preservar su snapshot histórico.

### 7.2 TransferPayment

| Campo | Descripción |
|---|---|
| `id, leadId, conversationId, contactId` | Vínculos CRM. |
| `bankAccountId` | Cuenta seleccionada. |
| `bankAccountSnapshot` | Datos exactos enviados al cliente. |
| `amountExpected, currency` | Monto esperado y moneda. |
| `status` | Estado del intento. |
| `sourceMessageId` | Mensaje que pidió la cuenta. |
| `instructionsMessageId` | Mensaje de Hermes con instrucciones. |
| `proofMessageIds` o relación `TransferPaymentProofMessage` | IDs de mensajes de WhatsApp con comprobantes; no contiene archivo ni URL. |
| `reviewedProofMessageId` | Mensaje que el operador usó para la decisión. |
| `proofReceivedAt, reviewStartedAt, approvedAt, rejectedAt` | Tiempos de operación. |
| `approvedByUserId, rejectedByUserId, reviewNote` | Decisión humana. |
| `idempotencyKey` | Evita duplicados por reintentos. |

La relación de comprobantes debe ser única por `messageId`, conservar su orden de recepción y validar que pertenezca a la misma conversación. No crear `storageKey`, URL, hash, tamaño, MIME ni entidad de archivo descargado.

### 7.4 Task y AuditLog

Agregar `PAYMENT_VERIFICATION` a `TaskType`. Al detectar un mensaje `IMAGE` o `DOCUMENT` en una transferencia abierta, crear o actualizar una tarea `PENDING` con prioridad operativa, enlace al lead/conversación y el `messageId` más reciente.

Registrar como mínimo:

- `BANK_ACCOUNT_CREATED`, `BANK_ACCOUNT_UPDATED`, `BANK_ACCOUNT_DEACTIVATED`;
- `TRANSFER_INSTRUCTIONS_SENT`, `TRANSFER_PROOF_RECEIVED`;
- `TRANSFER_REVIEW_STARTED`, `TRANSFER_APPROVED`, `TRANSFER_REJECTED`;
- `LEAD_PAYMENT_STAGE_CHANGED`.

## 8. API Hermes

Todas las rutas requieren JWT y guards de roles.

| Método y ruta | Roles | Uso |
|---|---|---|
| `GET /api/bank-accounts` | ADMIN | Lista cuentas enmascaradas. |
| `POST /api/bank-accounts` | ADMIN | Crea cuenta. |
| `PUT /api/bank-accounts/:id` | ADMIN | Edita/desactiva cuenta. |
| `GET /api/transfers/:id` | Rol de revisión | Detalle, historial y referencias de mensajes; la UI enlaza al Inbox de la conversación. |
| `POST /api/transfers/:id/start-review` | Rol de revisión | Reclama la revisión opcionalmente. |
| `POST /api/transfers/:id/approve` | ADMIN inicialmente | Aprueba usando `reviewedProofMessageId` y finaliza venta. |
| `POST /api/transfers/:id/reject` | ADMIN inicialmente | Rechaza con motivo obligatorio. |

No devolver números completos de cuenta en listados ni en endpoints de lectura general. No crear `GET /api/transfers/review`, URLs temporales ni endpoints de descarga persistente: las tareas y filtros de Inbox mostrarán `PAYMENT_VERIFICATION`. La única ruta de media será `GET /api/conversations/:id/messages/:messageId/media`, protegida por JWT y roles, con validación de pertenencia del mensaje a la conversación, límite de tamaño y respuesta `inline` sin caché.

`approve` y `reject` deben recibir control de concurrencia (`expectedStatus`/versión), ejecutarse dentro de una transacción y responder conflicto si otro operador terminó primero.

## 9. Conversación y media de Meta

### 9.1 Mensaje de transferencia

La plantilla de servidor debe ser parecida a:

~~~text
Puedes realizar la transferencia con estos datos:

Banco: {bankName}
Titular: {accountHolder}
Tipo de cuenta: {accountType}
Cuenta: {accountNumber}
Moneda: {currency}
Referencia: {reference}

Cuando la realices, envíanos por este chat el comprobante para validarlo.
~~~

Se persiste el mensaje final y el snapshot. El LLM no sustituye variables sensibles ni confirma disponibilidad de cuentas.

### 9.2 Detección de comprobante

El webhook de Hermes ya reconoce `IMAGE` y `DOCUMENT`. Crear `PaymentProofDetectionService` después de persistir el mensaje:

1. buscar transferencia abierta del contacto/conversación;
2. aceptar solo mensajes de imagen o documento que pertenezcan a esa conversación; no descargar su contenido desde Meta;
3. crear de forma idempotente la referencia al `messageId` en el intento;
4. cambiar el intento a `PROOF_RECEIVED`/`UNDER_REVIEW`, lead a `PAYMENT_REVIEW` y crear o actualizar la tarea;
5. enviar el aviso fijo: “Recibimos tu comprobante. Nuestro equipo lo validará y se comunicará contigo apenas esté confirmado.”

El mensaje original continuará visible únicamente en el Inbox de esa conversación. Al abrirlo, el backend consultará Meta en ese momento y transmitirá el contenido en línea, sin guardarlo. La tarea debe dirigir al operador a ese chat.

No crear handoff automático al recibir voucher: `HANDED_OFF` desactiva al asistente. La tarea de validación permite que Hermes responda estados reales mientras el equipo revisa. Un handoff solo se genera por petición del cliente, rechazo complejo o decisión del operador.

### 9.3 Respuestas durante la revisión

| Situación | Respuesta correcta |
|---|---|
| “¿Recibieron mi comprobante?” | Informar que fue recibido y sigue en validación si `PROOF_RECEIVED/UNDER_REVIEW`. |
| “¿Ya aprobaron?” | Confirmar únicamente si `APPROVED`; de otro modo indicar estado real. |
| Nuevo voucher | Asociar el nuevo mensaje y conservar tarea abierta. |
| Solicitud de humano | Activar handoff actual. |

## 10. Cambios por repositorio

### Hermes backend

| Ubicación | Trabajo |
|---|---|
| `prisma/schema.prisma` | Enums, entidades, relaciones e índices. |
| `prisma/migrations/*` | Migración SQL revisada y aplicada con backup. |
| `src/payments/*` (nuevo) | Módulo, controller, DTO, policy, service, detección y pruebas. |
| `src/app.module.ts` | Importar `PaymentsModule`. |
| `src/leads/leads.service.ts` | Transiciones, orden/prioridad y blindaje de `WON`. |
| `src/auto-replies/auto-reply.service.ts` | Activar política y respuestas de estado. |
| `src/webhook/webhook.service.ts` | Pasar mensajes media persistidos a la detección. |
| `src/conversation-engine/*` | Nuevo intent/contexto, sin nuevas acciones autónomas de pago. |
| `src/tasks/*` | Tipo, referencia a mensaje y navegación a conversación. |

Reutilizar el cliente Meta para lectura temporal del adjunto desde Inbox. No crear módulo de storage, entidad `TransferProof` basada en archivo ni rutas de descarga permanente.

### UnderCodeEC Next.js

| Ubicación | Trabajo |
|---|---|
| `src/lib/hermes/api.js` | Métodos de cuentas, detalle de transfer, inicio de revisión, approve y reject. |
| `src/app/admin/crm/_components/constants.js` | Etapas y metadatos visuales de pago. |
| `src/app/admin/crm/leads/page.jsx` | Columna prioritaria, filtros y orden. |
| `src/app/admin/crm/leads/[id]/page.jsx` | Estado, historial y acciones de transferencia; enlace al Inbox, sin visor ni descarga. |
| `src/app/admin/crm/administracion/*` | Gestión de cuentas. |
| Chat Inbox y tareas existentes | Mostrar tarea/estado y abrir la conversación correspondiente para revisar el adjunto nativo. |
| `src/app/admin/crm/crm.css` | Estados y alerta de prioridad. |

No crear `/admin/crm/pagos`, visor de comprobantes ni componente de descarga.

## 11. Fases de trabajo

### Fase 0 — Preparación

- [ ] Confirmar roles de aprobación; recomendación inicial: solo `ADMIN`.
- [ ] Confirmar bancos, titular, moneda, instrucciones y referencia requerida.
- [ ] Confirmar que Inbox conserva y autoriza correctamente los medios de WhatsApp para la conversación asignada.
- [ ] Hacer backup verificable de PostgreSQL Hermes.
- [ ] Documentar secretos, sin confirmarlos: token Meta y key de cifrado de cuentas.

**Criterio de salida:** decisiones comerciales, permisos de Inbox y seguridad aprobados.

### Fase 1 — Esquema y cuentas

- [ ] Agregar modelos/enums Prisma y generar migración.
- [ ] Crear `PaymentsModule`, DTOs y CRUD de cuentas.
- [ ] Cifrar números de cuenta al guardar; enmascarar en listados.
- [ ] Agregar roles, auditoría y desactivación lógica.
- [ ] Probar DTO, permisos, cifrado y migración.

**Criterio de salida:** administrador administra cuentas; usuarios no autorizados no ven datos sensibles.

### Fase 2 — Intención e instrucciones

- [ ] Crear `TransferIntentPolicy` y pruebas parametrizadas.
- [ ] Implementar etapas y transiciones de lead.
- [ ] Crear transferencia idempotente y snapshot.
- [ ] Integrar política en auto-respuestas.
- [ ] Enviar plantilla de instrucciones desde `PaymentService`.
- [ ] Validar ausencia de cuentas activas y mensajes ambiguos.

**Criterio de salida:** solo una petición válida crea `PAYMENT_PENDING` y envía una sola cuenta apta.

### Fase 3 — Comprobantes en Inbox

- [ ] Crear `PaymentProofDetectionService` sobre mensajes ya persistidos.
- [ ] Asociar de forma idempotente `messageId` al intento, sin descargar media.
- [ ] Generar o actualizar tarea `PAYMENT_VERIFICATION` con enlace a la conversación.
- [ ] Cambiar estado y enviar aviso de revisión.
- [ ] Cubrir reintentos, varios comprobantes y mensajes de otra conversación.

**Criterio de salida:** un comprobante enviado se ve solo en el Inbox de su conversación y genera una única revisión operativa.

### Fase 4 — Decisión humana

- [ ] Crear endpoints de detalle, reclamar, aprobar y rechazar.
- [ ] Exigir comentario para rechazo y `reviewedProofMessageId` para aprobación.
- [ ] Aplicar bloqueo transaccional y control de versión.
- [ ] Completar tarea al finalizar.
- [ ] Al aprobar: `WON`, campos contractuales, auditoría, conversión y mensaje.
- [ ] Al rechazar: conservar referencias de mensajes y volver a etapa autorizada.

**Criterio de salida:** dos operadores no pueden finalizar dos veces; una aprobación genera un único `CONTRACT_WON`.

### Fase 5 — UI CRM

- [ ] Construir gestión de cuentas en Administración.
- [ ] Añadir `Pago pendiente` y `Validación` al pipeline.
- [ ] Mostrar tareas de validación en los mecanismos existentes y abrir el Inbox de la conversación.
- [ ] Añadir estado y acciones de transferencia a la ficha del lead, sin renderizar ni descargar el archivo.
- [ ] Revisar experiencia móvil, teclado y permisos visuales.

**Criterio de salida:** un operador trabaja el flujo completo sin base de datos, terminal ni enlaces manuales.

### Fase 6 — Validación, despliegue y observabilidad

- [ ] Ejecutar pruebas backend, frontend e integración.
- [ ] Probar webhook Meta en sandbox o cuenta controlada.
- [ ] Agregar métricas: solicitudes, comprobantes detectados, aprobados, rechazados y SLA.
- [ ] Desplegar backend/migración con feature flag apagado.
- [ ] Desplegar UI, probar una cuenta de prueba y activar gradualmente.
- [ ] Monitorear 24 horas y documentar incidencias.

**Criterio de salida:** operación productiva monitorizada y con rollback probado.

## 12. Seguridad, privacidad y retención

1. Cifrar números de cuenta en reposo y no incluirlos en logs o telemetría.
2. Obtener el adjunto de Meta solo al abrirlo desde Inbox y no duplicarlo ni almacenarlo; aplicar los controles de acceso de la conversación.
3. Verificar que un usuario solo pueda llegar al Inbox de conversaciones que ya tiene autorizadas; no aceptar un `messageId` de otra conversación al aprobar.
4. Guardar usuario, timestamp, mensaje revisado y motivo de decisión en auditoría.
5. Desactivar, no borrar, cuentas usadas anteriormente.
6. La retención del comprobante es la del mensaje de WhatsApp/conversación existente; no se crea una política ni almacenamiento paralelo.

## 13. Pruebas obligatorias

### Unitarias

- Política de intención: positivos, negativos, negaciones y falta de contexto.
- Selección de cuenta por moneda, actividad y prioridad.
- Cifrado/masking de cuenta.
- Transiciones lead/transferencia.
- Idempotencia de instrucciones, referencias de comprobante y aprobación.
- Permisos por rol y validación de pertenencia conversación/mensaje.

### Integración

- Webhook de imagen/PDF -> referencia de mensaje -> tarea -> `PAYMENT_REVIEW`.
- Reintento del webhook sin duplicar referencia, tarea ni estado.
- Mensaje multimedia de otra conversación no se asocia a la transferencia.
- Aprobación simultánea por dos operadores: solo una exitosa.
- Rechazo sin comentario: error de validación.
- Aprobación -> `WON` -> una sola conversión.

### Aceptación manual

1. Crear una cuenta activa.
2. Iniciar una conversación con producto y monto definidos.
3. Enviar “Pásame los datos para transferir”.
4. Confirmar `PAYMENT_PENDING`, mensaje y snapshot.
5. Adjuntar PDF/JPG desde WhatsApp.
6. Confirmar tarea, `PAYMENT_REVIEW` y mensaje de validación.
7. Abrir la tarea y llegar al Inbox de esa conversación; revisar el adjunto allí, sin descarga ni visor adicional.
8. Confirmar `WON`, auditoría y evento comercial único.

## 14. Configuración propuesta

Añadir a `.env.example` sin valores reales:

~~~dotenv
PAYMENTS_TRANSFER_ENABLED=false
PAYMENTS_ACCOUNT_ENCRYPTION_KEY=
PAYMENTS_REVIEW_SLA_HOURS=24
~~~

No añadir variables de bucket, storage, retención de archivos ni descarga de media. La bandera `PAYMENTS_TRANSFER_ENABLED` debe impedir envío automático de cuentas y detección de comprobantes hasta completar configuración, pruebas y permisos.

## 15. Despliegue y rollback

### Orden de despliegue

1. Realizar backup verificable de PostgreSQL.
2. Aplicar migración y desplegar Hermes con flag apagado.
3. Crear cuenta de prueba y probar API como administrador.
4. Desplegar Next.js y comprobar navegación desde tarea a Inbox.
5. Activar el flag para un administrador/cuenta de prueba.
6. Realizar la aceptación manual completa.
7. Activar gradualmente y monitorear el SLA de revisión.

### Rollback

- Apagar inmediatamente `PAYMENTS_TRANSFER_ENABLED` para detener nuevas instrucciones y detecciones automáticas.
- No borrar transfers ni referencias de mensajes ya creadas; son evidencia.
- Corregir esquema mediante migración correctiva, no borrado destructivo en producción.
- El comprobante original continúa en Inbox conforme a la retención de la conversación.

## 16. Protocolo para retomar en otra sesión

1. Revisar `git status` en ambos repositorios y preservar cambios ajenos.
2. Leer este documento y continuar desde la primera casilla pendiente de la fase activa.
3. Confirmar que roles, acceso a Inbox y criterio de `WON` siguen vigentes.
4. Completar una fase por vez, ejecutar sus pruebas y actualizar las casillas.
5. Registrar commit, fecha, entorno probado y decisiones cambiadas en la tabla siguiente.

| Fase | Estado | Commit | Fecha | Notas |
|---|---|---|---|---|
| 0 — Preparación | Pendiente de entorno y datos bancarios | — | 2026-10-02 | Revisar backup, permisos y clave antes de aplicar migración. |
| 1 — Esquema/cuentas | Código listo; migración validada en bases aisladas | — | 2026-10-02 | No aplicada a la base principal; antes requiere backup y definir el entorno de destino. |
| 2 — Intención/instrucciones | Código listo; sin prueba Meta | — | 2026-10-02 | Flag apagado. |
| 3 — Comprobantes en Inbox | Código listo; sin prueba Meta | — | 2026-10-02 | Media solo se obtiene al abrir el chat. |
| 4 — Revisión/cierre | Código listo; falta recorrido real | — | 2026-10-02 | Aprobar/rechazar en Inbox. |
| 5 — UI CRM | Código listo; falta revisión manual | — | 2026-10-02 | Sin página de pagos adicional. |
| 6 — Despliegue | Pendiente | — | — | — |

## 17. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Falso positivo de intención | Política determinística, contexto obligatorio, negaciones y feature flag. |
| Cuenta incorrecta enviada | Solo cuentas activas, selección por moneda/prioridad y snapshot. |
| Voucher fraudulento | Validación humana obligatoria; no `WON` al recibir archivo. |
| Exposición del comprobante | Solo permanece en Inbox con sus permisos existentes; no hay copias ni enlaces de descarga. |
| Media ya no disponible en Meta | El mensaje y la decisión siguen auditados, pero el adjunto puede dejar de abrirse; revisar dentro del SLA y solicitar reenvío si Meta ya no lo entrega. |
| Asociación con otra conversación | Validar `conversationId` y pertenencia del `messageId` antes de asociar o aprobar. |
| Webhook o aprobación duplicada | Idempotencia, índices únicos, bloqueo transaccional y pruebas de concurrencia. |
| Exposición de datos bancarios | Cifrado, RBAC, masking y logs/prompt sanitizados. |
| Silencio durante revisión | Respuestas basadas en estado persistido y tarea, no promesas inventadas. |

## 18. Pruebas locales ejecutadas (2026-10-02)

- PostgreSQL en Docker: las 19 migraciones se aplicaron desde cero en una base temporal y `prisma migrate status` confirmó el esquema actualizado.
- Se clonó la base local de Hermes en una segunda base temporal: las cinco migraciones pendientes, incluida `20261002000000_transfer_payments`, se aplicaron correctamente sobre sus datos existentes. Se verificó la presencia de las tres tablas nuevas. Ambas bases temporales y el usuario temporal de prueba se eliminaron al terminar.
- Backend: 56 suites y 947 pruebas unitarias aprobadas; las tres suites específicas de pagos sumaron 16 pruebas aprobadas.
- Frontend: 32 pruebas seleccionadas de mensajes de pago y contrato de leads aprobadas. La compilación y las pruebas CRM dirigidas también se habían validado durante la implementación.
- La base principal no se migró ni se desplegó la aplicación. `PAYMENTS_TRANSFER_ENABLED` permanece apagado. Falta probar el recorrido real con Meta/WhatsApp y la revisión visual en Inbox antes de activar la función.
- En esta máquina otro PostgreSQL escucha en el puerto 5432 de Windows; las pruebas de migración se ejecutaron desde contenedores efímeros en la red de `hermes-postgres` para apuntar inequívocamente a la base correcta.
