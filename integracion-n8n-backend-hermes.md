# Integración de n8n dentro del backend actual con Hermes y Meta WhatsApp Cloud API

Este documento describe cómo integrar n8n en un backend ya existente basado en NestJS, Prisma y PostgreSQL, manteniendo a Hermes como motor agente y a Meta WhatsApp Cloud API como canal oficial.[cite:121][cite:123][cite:128]

La idea central es que n8n no reemplace el backend actual, sino que funcione como una capa adicional de automatización desacoplada, activada por eventos de dominio del sistema comercial ya implementado.[cite:143][cite:133][cite:132]

## Lectura del estado actual

El documento técnico existente indica que el backend comercial ya está implementado con NestJS, TypeScript, Prisma ORM y PostgreSQL, y que el webhook `POST /webhooks/meta/whatsapp` ya ejecuta el ciclo principal de procesamiento de mensajes.[cite:132]

También se deja claro que la arquitectura actual ya contiene módulos de CRM, conversaciones, Meta API, Hermes API, campañas, tareas, analítica y handoff, por lo que el backend ya actúa como capa orquestadora principal.[cite:132]

Esto coloca el proyecto en una etapa de **preproducción avanzada**: la base transaccional existe, la topología de negocio ya fue elegida y los pendientes están más relacionados con despliegue, credenciales reales, exposición pública del webhook y endurecimiento operativo.[cite:132]

## Decisión arquitectónica correcta

Dado el estado actual, n8n debe entrar como **capa de automatización por eventos**, no como punto de verdad del CRM ni como reemplazo del webhook central del backend.[cite:132][cite:143]

La razón es simple: el backend ya concentra validación, persistencia, reglas comerciales, contexto de leads, integración con Hermes y envío hacia Meta. Duplicar ese flujo completo en n8n aumentaría la complejidad y rompería la separación de responsabilidades que ya está bien definida en el sistema actual.[cite:132]

## Papel de cada componente

| Componente | Papel principal | Qué no debe hacer |
|---|---|---|
| Backend NestJS | Núcleo transaccional, verdad operativa, validación, reglas, persistencia, integración con Meta y Hermes [cite:132] | No debe convertirse en editor visual de automatizaciones |
| Hermes | Motor cognitivo, memoria útil, generación de respuesta, clasificación, intención y siguiente acción [cite:128][cite:82] | No debe ser la base de datos principal del negocio [cite:132] |
| n8n | Automatización desacoplada, flujos auxiliares, integraciones externas, tareas reactivas y programadas [cite:121][cite:133] | No debe reemplazar el estado del CRM ni el control principal de conversaciones |
| Meta WhatsApp Cloud API | Canal oficial de entrada y salida de mensajes [cite:123] | No debe contener lógica comercial |
| PostgreSQL | Persistencia estructurada de leads, mensajes, estados y analítica [cite:132] | No debe contener automatización por sí solo |

## Cuándo debe dispararse n8n

n8n debe dispararse cuando ocurra un **evento de negocio** relevante en el backend, no en cada detalle interno sin criterio. La activación más sana es por eventos de dominio bien definidos, porque eso mantiene el diseño limpio y desacoplado.[cite:133][cite:130][cite:143]

Los eventos más útiles para disparar n8n dentro de tu arquitectura son estos:[cite:132][cite:121]

- `lead.created`
- `lead.qualified`
- `conversation.message_received`
- `conversation.response_sent`
- `conversation.handoff_requested`
- `task.followup_due`
- `campaign.lead_attributed`
- `conversation.stalled`
- `payment.intent_detected`
- `quote.requested`

## Qué lógica funcional sí debes agregar al backend

Sí, necesitas agregar una capa funcional mínima para hablar con n8n desde el backend actual.[cite:133][cite:143]

La lógica recomendada consiste en:

1. Detectar un evento de dominio dentro de tu servicio de aplicación o módulo.
2. Construir un payload consistente y estable.
3. Enviar ese payload a un webhook de n8n mediante HTTP POST.
4. Registrar el resultado de la llamada.
5. Reintentar, encolar o degradar el flujo si n8n no responde.

Esto convierte a n8n en un consumidor de eventos del backend, no en el dueño del core del sistema.[cite:143][cite:133]

## Topología recomendada

La topología más limpia para tu caso sería esta:[cite:123][cite:126][cite:132]

1. Meta envía webhook al backend NestJS.[cite:132]
2. El backend valida la firma, guarda datos y obtiene contexto.[cite:132]
3. El backend llama a Hermes para generar respuesta o clasificación.[cite:132][cite:128]
4. El backend decide la acción principal y responde por Meta si corresponde.[cite:132][cite:123]
5. El backend emite uno o varios eventos secundarios hacia n8n para automatizaciones complementarias.[cite:133][cite:143]
6. n8n ejecuta tareas externas, notificaciones, nurturing, integraciones o procesos diferidos.[cite:121][cite:119]

## Dónde insertar n8n en el backend actual

A nivel de código, n8n debe entrar en la **capa de aplicación**, no en entidades ni en acceso directo a base de datos. Es decir, el punto correcto es después de que el caso de uso principal ya conoce qué pasó y con qué datos debe notificar a otros sistemas.

En NestJS esto normalmente significa integrarlo desde servicios como:

- `LeadsService`
- `ConversationsService`
- `WebhookMetaService`
- `HandoffService`
- `TasksService`
- `CampaignsService`

Cada uno puede publicar eventos hacia un `N8nService` común en vez de llamar directamente a n8n por todos lados.

## Servicio técnico recomendado en NestJS

Conviene crear un módulo dedicado, por ejemplo `IntegrationsModule`, con un servicio `N8nService` responsable de enviar eventos al webhook correcto.[cite:133]

### Responsabilidades de `N8nService`

- Resolver URL de cada workflow de n8n desde variables de entorno.
- Firmar o autenticar la llamada si decides proteger el webhook.
- Estandarizar headers y timeouts.
- Manejar errores y reintentos.
- Registrar métricas y logs de integración.
- No contener lógica de negocio; solo transporte y confiabilidad.

### Ejemplo conceptual de interface

```ts
export interface N8nEventPayload {
  event: string;
  occurredAt: string;
  traceId?: string;
  leadId?: string;
  conversationId?: string;
  contactId?: string;
  data: Record<string, unknown>;
}
```

### Ejemplo conceptual del servicio

```ts
@Injectable()
export class N8nService {
  constructor(private readonly http: HttpService) {}

  async dispatch(workflowUrl: string, payload: N8nEventPayload) {
    return this.http.axiosRef.post(workflowUrl, payload, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'x-integration-source': 'hermes-backend',
      },
    });
  }
}
```

## Estrategia de webhooks n8n

n8n documenta el nodo **Webhook** como trigger para recibir datos desde aplicaciones y servicios, lo cual encaja de forma natural con un backend que emite eventos por HTTP.[cite:133]

Para tu arquitectura, el patrón recomendado es tener **webhooks específicos por automatización** o por grupo funcional, en lugar de un único webhook gigante para todo el sistema. Eso facilita mantenimiento, seguridad, observabilidad y evolución.[cite:133][cite:130]

### Ejemplo de separación de workflows

- `/webhook/lead-created`
- `/webhook/lead-qualified`
- `/webhook/followup-due`
- `/webhook/handoff-requested`
- `/webhook/conversation-stalled`
- `/webhook/daily-sales-summary`

## Tipos de workflows que sí conviene mover a n8n

n8n es especialmente fuerte en automatizaciones reactivas y de integración externa.[cite:121][cite:119]

Estos casos son buenos candidatos:

- Notificar leads calientes por Telegram, Slack o email.
- Crear recordatorios de seguimiento.
- Sincronizar leads con Google Sheets o un CRM externo.
- Lanzar secuencias de nurturing después de cierto tiempo.
- Programar mensajes internos para el equipo comercial.
- Construir reportes diarios o semanales.
- Hacer enriquecimiento externo del lead con APIs de terceros.
- Ejecutar acciones cuando un lead se queda estancado.[cite:119][cite:121]

## Tipos de lógica que deben quedarse en el backend

Tu backend actual ya es el lugar correcto para la lógica crítica del negocio.[cite:132]

No conviene mover a n8n estas responsabilidades:

- Validación del webhook de Meta.
- Persistencia oficial de mensajes.
- Escritura principal en PostgreSQL.
- Gestión oficial del estado del lead.
- Políticas de seguridad y autorización.
- Decisión final de responder o no al cliente.
- Integración estructural con Hermes.
- Handoff transaccional a humano.

Si n8n falla, el negocio debe seguir operativo; por eso no debe contener el corazón del sistema.[cite:143][cite:132]

## Integración con el flujo actual de conversación

Tu documento previo describe un flujo de 10 pasos donde el backend recibe el mensaje, lo guarda, arma contexto, llama a Hermes, decide reglas de postprocesamiento y responde por Meta.[cite:132]

La inserción correcta de n8n ocurre **después** de ese flujo principal, o en ramas laterales no bloqueantes. Por ejemplo:

- Tras enviar una respuesta, disparar `conversation.response_sent`.
- Si Hermes detecta lead caliente, disparar `lead.qualified`.
- Si no hay respuesta del cliente por cierto tiempo, disparar `conversation.stalled`.
- Si se pide cotización, disparar `quote.requested`.

De esta forma, n8n amplifica el sistema sin alterar el camino crítico principal.[cite:132][cite:121]

## Flujo recomendado con n8n + Hermes

### Flujo principal síncrono

1. Meta manda evento a `POST /webhooks/meta/whatsapp`.[cite:132]
2. El backend valida la firma y normaliza el payload.[cite:132]
3. El backend guarda contacto, conversación y mensaje.[cite:132]
4. El backend arma contexto comercial y documental.[cite:132]
5. El backend llama a Hermes.[cite:132][cite:128]
6. Hermes devuelve respuesta, intención, tags y acción sugerida.[cite:128][cite:82]
7. El backend decide responder, pausar o derivar.[cite:132]
8. El backend responde por Meta.[cite:123][cite:132]

### Flujo secundario asíncrono

9. El backend emite eventos secundarios a n8n.[cite:133][cite:143]
10. n8n ejecuta notificaciones, seguimientos, integraciones o tareas futuras.[cite:121][cite:119]
11. Si hace falta, n8n llama otra API de tu backend para registrar resultados de la automatización.

## Payload recomendado para n8n

El payload debe ser estable, legible y versionable. Una buena práctica es incluir tipo de evento, timestamps, IDs de negocio y un bloque `data` con el detalle útil.

### Ejemplo de payload

```json
{
  "event": "lead.qualified",
  "version": "1.0",
  "occurredAt": "2026-06-27T22:00:00Z",
  "traceId": "d08f2d0a-7d65-4c2f-bc7d-5d8b8b2b77d1",
  "leadId": "lead_123",
  "contactId": "contact_456",
  "conversationId": "conv_789",
  "data": {
    "name": "Juan Pérez",
    "phone": "+593xxxxxxxxx",
    "intent": "pricing_request",
    "score": 0.87,
    "productInterest": "hosting_vps",
    "campaign": "meta-junio-vps",
    "nextAction": "notify_sales_team"
  }
}
```

## Seguridad de la integración

Como n8n expondrá webhooks, conviene protegerlos incluso si solo reciben tráfico de tu backend.[cite:133][cite:136]

### Medidas mínimas

- Token secreto por webhook.
- Header personalizado como `x-internal-token`.
- Rate limiting si el despliegue lo permite.
- Permitir solo peticiones desde tu VPS o red de confianza si usas reverse proxy.
- Timeouts cortos en llamadas desde el backend.
- Logs con `traceId` para correlación entre backend y n8n.

## Sincronía vs asincronía

No todas las llamadas a n8n deben ser síncronas. Para tu caso, la mayoría de automatizaciones deben ser **asíncronas** para no retrasar la respuesta principal al cliente.[cite:143][cite:133]

### Usar síncrono solo cuando

- La salida de n8n es necesaria para responder al usuario en ese instante.
- El workflow es corto, confiable y controlado.

### Usar asíncrono cuando

- Solo quieres notificar, registrar, programar o enriquecer.
- El cliente no debe esperar la finalización del workflow.
- El fallo del workflow no debe romper la conversación.

## Patrón de eventos recomendado

A nivel de diseño, el backend debería emitir eventos internos primero, y después decidir si esos eventos salen a n8n. Esto permite crecer más ordenadamente.

### Opción simple

El servicio de negocio llama a `N8nService.dispatch()` directamente.

### Opción más limpia

El servicio de negocio publica un evento interno, por ejemplo `LeadQualifiedEvent`, y un listener se encarga de disparar n8n.

Ese patrón mejora pruebas, mantenibilidad y desacoplamiento dentro de NestJS.

## Propuesta de capas en tu proyecto actual

```text
controllers/
services/
domain-events/
listeners/
integrations/
  n8n/
    n8n.module.ts
    n8n.service.ts
    n8n.types.ts
    n8n.constants.ts
```

## Workflows iniciales recomendados en n8n

Para no sobrecomplicar el arranque, conviene empezar solo con workflows de alto valor.

### Lote 1

- `lead-qualified-notify-sales`
- `handoff-requested-alert`
- `conversation-stalled-followup`
- `daily-sales-summary`

### Lote 2

- `campaign-lead-sync-to-sheet`
- `quote-requested-create-task`
- `new-hot-lead-send-slack-and-email`
- `lead-no-response-24h-nurture`

## Orden de implementación sugerido

### Etapa 1: integración mínima

- Instalar n8n en el VPS.[cite:103][cite:110]
- Crear un workflow simple con nodo Webhook.[cite:133]
- Crear `N8nService` en NestJS.
- Enviar un evento de prueba desde el backend.
- Registrar logs y validar seguridad.

### Etapa 2: primer workflow útil

- Elegir un solo evento, por ejemplo `lead.qualified`.
- Hacer que el backend lo dispare después de clasificar con Hermes.
- En n8n, notificar al equipo y registrar una acción auxiliar.
- Confirmar que si n8n falla, el flujo principal sigue funcionando.

### Etapa 3: automatización real

- Añadir `conversation.stalled`.
- Añadir `handoff.requested`.
- Añadir `daily-sales-summary` con ejecución programada.
- Añadir integraciones externas de reporting o nurturing.[cite:121]

### Etapa 4: madurez operativa

- Estandarizar payloads.
- Añadir reintentos o cola si hace falta.
- Versionar los eventos.
- Documentar contratos entre backend y n8n.
- Añadir trazabilidad end-to-end.

## Ejemplo de caso concreto en tu sistema

Supongamos este escenario:

1. Entra un lead por WhatsApp desde una campaña de Meta.[cite:123][cite:132]
2. Tu backend guarda el contacto y la conversación.[cite:132]
3. Hermes detecta que el usuario preguntó por precio y tiene alta intención de compra.[cite:128][cite:82]
4. El backend responde al cliente y marca el lead como calificado.[cite:132]
5. Inmediatamente después, el backend dispara el webhook `lead-qualified` de n8n.[cite:133]
6. n8n manda alerta al vendedor, crea recordatorio de seguimiento y registra una salida en una hoja o dashboard externo.[cite:119][cite:121]

Ese flujo usa lo mejor de cada capa sin mezclar responsabilidades.[cite:132][cite:143]

## Qué capa de desarrollo tienes ahora

Basado en tu archivo previo, ya estás más allá del diseño conceptual y del simple prototipo, porque el backend principal ya existe y la topología central ya está definida.[cite:132]

La etapa actual puede resumirse así:

| Capa | Estado |
|---|---|
| Arquitectura general | Definida [cite:132] |
| Backend comercial | Implementado [cite:132] |
| Persistencia CRM | Implementada en gran parte [cite:132] |
| Flujo principal con Hermes | Implementado según el documento [cite:132] |
| Integración Meta productiva | Pendiente de configuración real [cite:132] |
| Exposición pública del webhook | Pendiente [cite:132] |
| Integración n8n | No integrada todavía; siguiente paso lógico [cite:132][cite:133] |

## Recomendación final de arquitectura

La mejor decisión para tu caso no es “migrar a n8n”, sino **acoplar n8n por eventos al backend existente**.[cite:132][cite:143]

Esto conserva el backend como sistema de registro y control, conserva a Hermes como cerebro del vendedor digital y usa n8n como acelerador de automatizaciones externas, reporting y operaciones no críticas en tiempo real.[cite:121][cite:128][cite:132]
