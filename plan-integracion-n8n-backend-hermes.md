# Plan de implementación — Integración n8n + backend Hermes

> Documento de trabajo. Pensado para retomarse en sesiones futuras sin perder contexto. Si abrís este archivo en otra sesión, leelo de arriba hacia abajo: la sección 1 reconstruye el estado, las secciones 2–4 fijan la decisión arquitectónica, las 5–10 son el roadmap de implementación, y la 11 es el checklist accionable para arrancar.

---

## 1. Estado del proyecto al momento de redactar este plan

Fecha: 2026-06-28.

### 1.1 Repositorio

- Ruta raíz local: `D:\Documentos\Hermes\`.
- Backend NestJS en `D:\Documentos\Hermes\hermes-backend\`.
- Documentos de contexto previos:
  - `guia-hermes-vps-meta-whatsapp.md` — guía maestra de arquitectura (VPS + Meta + Hermes + backend).
  - `integracion-n8n-backend-hermes.md` — propuesta inicial de integración con n8n.
- **Repositorio git inicializado y publicado en GitHub** (2026-06-28): `https://github.com/undercodeec/hermes_n8n.git`, rama `main`. `.gitignore` excluye `.env`, `node_modules/`, `dist/`, `*.md` (los docs internos no se versionan).
- **Copia desplegada en VPS**: `/var/www/hermes/` (RackNerd, subdominio `hermes.undercodeec.com`). El backend NestJS quedó mapeado al puerto 3003 (host y contenedor); Nginx hace reverse proxy + TLS via Let's Encrypt para que Meta pueda alcanzar el webhook.

### 1.2 Backend NestJS — qué ya está implementado

Stack actual confirmado en `hermes-backend/package.json`:

- NestJS 11, TypeScript 5.7, Prisma 5.22, PostgreSQL.
- Axios 1.18 disponible.
- Auth con JWT/Passport.
- **NO** instalado todavía: `@nestjs/event-emitter`, `bullmq`, `@nestjs/bullmq`, `ioredis`, `nestjs-cls`.

Módulos cargados en `src/app.module.ts` (16):

```
PrismaModule, AuthModule,
WebhookModule, MetaModule, HermesModule,
ContactsModule, LeadsModule, ConversationsModule, MessagesModule,
ProductsModule, PriceListsModule, KnowledgeModule, PlaybooksModule,
HandoffModule, TasksModule, CampaignsModule, AnalyticsModule
```

No existe aún `IntegrationsModule` ni nada relacionado a n8n.

### 1.3 Flujo actual del webhook

`src/webhook/webhook.service.ts` implementa el ciclo de 10 pasos descrito en la guía maestra de forma **síncrona** dentro de `processIncomingMessage`:

1. Upsert contacto.
2. Get/create conversación.
3. Guardar mensaje crudo INBOUND.
4. Early return si la conversación está en `HANDED_OFF`.
5. Build context (últimos 20 mensajes + state + lead).
6. `hermesService.generateResponse(...)`.
7. `checkHandoffSignals(...)` por keywords.
8. Si dispara, `createAutoHandoff(...)` (cambia status + crea HumanHandoff `PENDING`).
9. `metaService.sendTextMessage(...)`.
10. Guardar mensaje OUTBOUND + `updateConversationState(...)` con intent/tags/nextAction.

Puntos clave para la integración:

- Todo corre en serie con `await`. Cualquier llamada extra dentro de este método suma latencia al ciclo del webhook.
- No hay `traceId` propagado.
- No se emiten eventos de dominio: cuando un lead se califica, cuando hay handoff, cuando se responde — todo queda implícito en cambios de estado en DB.

### 1.4 Schema Prisma relevante (resumen para no releer 440 líneas)

Tablas que el sistema de eventos necesita conocer:

- `Contact` (waId único, name, phone, email, company, position).
- `Lead` (stage enum NEW→WON/LOST, score Int, productOfInterest, closeProbability 0–1, contactId, campaignSourceId).
- `Conversation` (status: ACTIVE/PAUSED/HANDED_OFF/CLOSED).
- `ConversationState` (summary, detectedIntent, nextSuggestedAction, commercialTags, closeScore).
- `Message` (direction INBOUND/OUTBOUND, type, content, tokensUsed, latencyMs, costEstimate, wamid).
- `HumanHandoff` (reason enum, status PENDING/ASSIGNED/IN_PROGRESS/RESOLVED/CANCELLED).
- `Task` (type FOLLOW_UP/APPOINTMENT/..., status PENDING/IN_PROGRESS/COMPLETED/CANCELLED, dueAt).
- `CampaignSource` + `AdsMetadata`.
- `AuditLog` (puede aprovecharse para auditar también dispatches de eventos).

### 1.5 `.env.example` actual

Variables presentes: `PORT`, `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRATION`, `META_*`, `HERMES_*`, `REDIS_URL` (este último ya está documentado pero marcado como "optional"). Para este plan, `REDIS_URL` deja de ser opcional.

### 1.6 Pendientes operativos del backend (no parte de este plan, pero importantes)

Estado al 2026-06-28 (cierre de sesión vespertina):

- [x] `.env` real configurado en el VPS (`/var/www/hermes/hermes-backend/.env`, `chmod 600`). Secretos de `JWT_SECRET`, `N8N_HMAC_SECRET`, `N8N_CALLBACK_TOKEN` generados con `openssl rand -hex 32`. `META_WEBHOOK_VERIFY_TOKEN=hermes_n8n_whatsapp_2026`.
- [x] Servicio NestJS agregado al `docker-compose.yml` como `app` (container `hermes-app`, `ports: 3003:3003`, `depends_on` postgres/redis/n8n con healthchecks). `Dockerfile` actualizado a `EXPOSE 3003`.
- [x] **`hermes-app` levantado** tras switch de imagen base `node:20-alpine` → `node:20-bookworm-slim` (detalle del diagnóstico en §14 revisión 5). Banner `HERMES BACKEND - RUNNING` en logs.
- [x] **Migraciones Prisma aplicadas**. Como `prisma/migrations/` estaba vacío, se generó la migración inicial con `docker compose exec app npx prisma migrate dev --name init` (timestamp `20260628184421_init`), se copió al host con `docker compose cp app:/app/prisma/migrations ./prisma/` y se commiteó al repo.
- [x] **Nginx reverse proxy** configurado en `/etc/nginx/sites-available/hermes.undercodeec.com` (proxy a `127.0.0.1:3003`, `client_max_body_size 10M`, `proxy_read_timeout 60s`). `nginx -t` OK, reload OK. `curl` HTTP local devuelve `test123`.
- [x] **HTTPS desplegado** (2026-06-28): `certbot --nginx -d hermes.undercodeec.com --non-interactive --agree-tos -m undercodeec@gmail.com --redirect` ejecutado. Certificado Let's Encrypt activo. Smoke test `curl "https://hermes.undercodeec.com/webhooks/meta/whatsapp?..."` → `test123` OK.
- [x] Registro del webhook en Meta Developers Dashboard (2026-06-28). Callback URL `https://hermes.undercodeec.com/webhooks/meta/whatsapp` verificada. Suscripciones activas: `messages`, `message_status`, `message_template_status_update`, `message_template_quality_update`. `META_PHONE_NUMBER_ID` ya cargado en `.env` del VPS y `app` reiniciado.
- [x] n8n incluido en `docker-compose.yml` (image `n8nio/n8n:latest`, basic auth, volumen `hermes_n8n_data`). **Expuesto en subdominio propio `n8n.undercodeec.com` con Nginx + TLS (2026-06-29).** Cuenta owner creada. Acceso permanente por HTTPS.
- [ ] **Migración a pnpm**: pendiente como tarea separada (rama propia) después de cerrar Etapa 0. Decidido en sesión por seguridad (incidentes recientes en npm registry) y escalabilidad. Notas: pnpm consume del mismo registry — la mitigación real de supply chain es `minimumReleaseAge` en `.npmrc`. NestJS requerirá `shamefully-hoist=true` para que los decorators funcionen. Guardada en memoria como `project-pnpm-migration`.

---

## 2. Decisión arquitectónica de fondo

n8n entra como **capa de automatización por eventos**, no como reemplazo ni del CRM ni del webhook central. Esto se mantiene del documento `integracion-n8n-backend-hermes.md`.

Lo que **cambia** respecto a la propuesta original: en lugar de que los servicios de dominio llamen a `N8nService.dispatch()` directamente (acoplamiento + `axios.post` síncrono dentro del flujo crítico), se introducen tres capas:

```
Servicio de dominio
      |  emit (LeadQualifiedEvent, ...)
      v
EventEmitter2 (in-process, sync por defecto)
      |  @OnEvent listener
      v
BullMQ queue ("n8n-events", Redis)
      |  worker consume
      v
N8nDispatcher (HMAC sign + axios POST con reintentos)
      |  HTTP
      v
n8n webhook (workflow específico)
```

### 2.1 Por qué no el patrón directo del documento original

- Sumar `await http.post(...)` al webhook puede empujar la latencia por encima del timeout efectivo de Meta y degrada la UX cuando n8n responde lento o cae.
- Sin cola, si n8n está caído o el contenedor reinicia, el evento se pierde sin trace.
- Acoplar `N8nService` dentro de `WebhookService`/`LeadsService`/etc. obliga a tocar muchos archivos cuando cambia el contrato.

### 2.2 Por qué no outbox transaccional (todavía)

El outbox pattern (escribir el evento en una tabla en la misma transacción que el cambio de negocio + worker que la lea) es estrictamente más robusto. Lo descartamos **para esta fase** porque:

- Para los workflows de Lote 1 (alertas a vendedores, recordatorios), perder un evento ocasional ante un crash es tolerable.
- Agrega complejidad de implementación significativa (worker polling, locks, manejo de dead-letter).
- BullMQ ya da retry + persistencia en Redis, cubriendo el 90% del caso.

Migración a outbox queda como **fase futura** si los workflows se vuelven operacionalmente críticos (ej. si el cobro automático depende de un evento).

### 2.3 Qué eventos serán críticos vs auxiliares

| Evento | Criticidad | Estrategia |
|---|---|---|
| `lead.qualified` | Alta (afecta ventas) | Cola con reintentos + alerta si DLQ crece |
| `conversation.handoff_requested` | Alta (humano debe atender) | Cola con reintentos + alerta DLQ |
| `conversation.stalled` | Media | Cola normal |
| `task.followup_due` | Media | Cola normal |
| `lead.created` | Baja | Cola normal |
| `conversation.message_received` | Baja, alto volumen | Considerar muestreo o skip |
| `conversation.response_sent` | Baja, alto volumen | Idem |
| `campaign.lead_attributed` | Media | Cola normal |
| `payment.intent_detected` | Alta | Cola + reintentos largos |
| `quote.requested` | Alta | Cola + reintentos largos |

Los daily summaries y reportes programados **no se modelan como eventos**: n8n los pulea por API REST del backend.

---

## 3. Stack que se va a sumar

### 3.1 Dependencias npm a instalar en `hermes-backend/`

```bash
npm install @nestjs/event-emitter @nestjs/bullmq bullmq ioredis nestjs-cls
```

Versiones objetivo (compatibles con NestJS 11):
- `@nestjs/event-emitter` ^3.0.0
- `@nestjs/bullmq` ^11.0.0
- `bullmq` ^5.0.0
- `ioredis` ^5.0.0
- `nestjs-cls` ^4.0.0

### 3.2 Infraestructura

- **Redis** (obligatorio para BullMQ). Agregar al `docker-compose.yml` del backend. Versión sugerida: `redis:7-alpine`.
- **n8n** self-hosted en el mismo VPS (o externo). Imagen `n8nio/n8n` con volumen persistente y reverse proxy.

### 3.3 Variables de entorno nuevas

A agregar en `hermes-backend/.env.example` y `.env`:

```env
# Redis (ahora obligatorio para queues)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# n8n integration
N8N_BASE_URL=http://localhost:5678
N8N_HMAC_SECRET=replace-with-strong-random-string

# Endpoints por workflow (URLs completas o paths)
N8N_WEBHOOK_LEAD_QUALIFIED=/webhook/lead-qualified
N8N_WEBHOOK_HANDOFF_REQUESTED=/webhook/handoff-requested
N8N_WEBHOOK_CONVERSATION_STALLED=/webhook/conversation-stalled
N8N_WEBHOOK_TASK_FOLLOWUP_DUE=/webhook/task-followup-due
N8N_WEBHOOK_QUOTE_REQUESTED=/webhook/quote-requested
N8N_WEBHOOK_PAYMENT_INTENT=/webhook/payment-intent-detected

# Feature flags (para apagar la integración sin re-deploy)
N8N_INTEGRATION_ENABLED=true
N8N_DISPATCH_TIMEOUT_MS=5000
N8N_MAX_RETRIES=5

# Calificación automática de leads (decidido en §9 punto 1)
LEAD_QUALIFICATION_SCORE_THRESHOLD=0.7
LEAD_QUALIFICATION_INTENTS=pricing_request,quote_request,payment_inquiry
```

---

## 4. Estructura de carpetas final

Dentro de `hermes-backend/src/`:

```
integrations/
  n8n/
    n8n.module.ts
    n8n.dispatcher.ts          # Sólo transporte: firma HMAC + axios + manejo de error
    n8n.config.ts              # Resolución de URLs por evento desde env
    n8n.constants.ts           # EVENT_NAMES, QUEUE_NAME, JOB_NAMES
    n8n.types.ts               # N8nEventPayload, EventName union
    n8n.queue.processor.ts     # BullMQ processor: consume cola → dispatcher
    listeners/
      lead.listener.ts         # @OnEvent('lead.qualified') → queue.add(...)
      conversation.listener.ts # handoff_requested, stalled, response_sent
      task.listener.ts         # followup_due
      quote.listener.ts        # requested
      payment.listener.ts      # intent_detected

common/
  events/
    domain-event.ts            # Clase base con eventId, occurredAt, traceId
    lead.events.ts             # LeadCreatedEvent, LeadQualifiedEvent
    conversation.events.ts     # ConversationHandoffRequestedEvent, Stalled, ResponseSent
    task.events.ts             # TaskFollowUpDueEvent
    quote.events.ts            # QuoteRequestedEvent
    payment.events.ts          # PaymentIntentDetectedEvent
  trace/
    trace.module.ts            # nestjs-cls bootstrap con traceId por request
    trace.middleware.ts        # genera/propaga traceId desde header
```

`IntegrationsModule` se importa en `app.module.ts` (un solo punto). Cada servicio de dominio inyecta `EventEmitter2`, **nunca** `N8nDispatcher` directamente.

---

## 5. Diseño de cada componente

### 5.1 Eventos de dominio (clases TS)

Cada evento es una clase simple. La razón de usar clases (y no strings + payloads sueltos) es typesafety + búsqueda + refactor seguro.

```ts
// common/events/domain-event.ts
import { randomUUID } from 'crypto';

export abstract class DomainEvent {
  readonly eventId: string = randomUUID();
  readonly occurredAt: string = new Date().toISOString();
  readonly version: string = '1.0';

  abstract readonly name: string; // ej: 'lead.qualified'

  constructor(public readonly traceId?: string) {}
}
```

```ts
// common/events/lead.events.ts
import { DomainEvent } from './domain-event';

export class LeadQualifiedEvent extends DomainEvent {
  readonly name = 'lead.qualified';

  constructor(
    public readonly leadId: string,
    public readonly contactId: string,
    public readonly conversationId: string,
    public readonly score: number,
    public readonly detectedIntent?: string,
    public readonly productOfInterest?: string,
    traceId?: string,
  ) {
    super(traceId);
  }
}

export class LeadCreatedEvent extends DomainEvent {
  readonly name = 'lead.created';
  constructor(
    public readonly leadId: string,
    public readonly contactId: string,
    traceId?: string,
  ) { super(traceId); }
}
```

Repetir patrón para los demás. Mantener el constructor con argumentos posicionales explícitos (no un objeto genérico) para que el typesystem fuerce a pasar todo lo necesario.

### 5.2 Payload que viaja a n8n

```ts
// integrations/n8n/n8n.types.ts
export interface N8nEventPayload {
  event: string;             // 'lead.qualified'
  version: string;           // '1.0'
  eventId: string;           // UUID — n8n lo usa para deduplicar
  occurredAt: string;        // ISO 8601
  traceId?: string;
  data: Record<string, unknown>; // body específico del evento
}
```

Mapeo de evento de dominio → payload se hace en los listeners (no en el dispatcher). Mantiene al dispatcher genérico.

### 5.3 Dispatcher (transporte)

Responsabilidades únicas: HMAC, timeout, axios, log, throw para que BullMQ reintente.

```ts
// integrations/n8n/n8n.dispatcher.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import axios from 'axios';
import { N8nEventPayload } from './n8n.types';

@Injectable()
export class N8nDispatcher {
  private readonly logger = new Logger(N8nDispatcher.name);

  constructor(private readonly config: ConfigService) {}

  async dispatch(webhookPath: string, payload: N8nEventPayload): Promise<void> {
    const baseUrl = this.config.getOrThrow<string>('N8N_BASE_URL');
    const secret = this.config.getOrThrow<string>('N8N_HMAC_SECRET');
    const timeoutMs = Number(this.config.get('N8N_DISPATCH_TIMEOUT_MS') ?? 5000);

    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    try {
      await axios.post(`${baseUrl}${webhookPath}`, payload, {
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'X-Hermes-Signature': `sha256=${signature}`,
          'X-Hermes-Event': payload.event,
          'X-Hermes-Event-Id': payload.eventId,
          'X-Hermes-Trace-Id': payload.traceId ?? '',
        },
      });
      this.logger.log(`Dispatched ${payload.event} (${payload.eventId})`);
    } catch (err: any) {
      this.logger.error(
        `Dispatch failed for ${payload.event} (${payload.eventId}): ${err.message}`,
      );
      throw err; // dejar que BullMQ reintente
    }
  }
}
```

### 5.4 Cola BullMQ

```ts
// integrations/n8n/n8n.constants.ts
export const N8N_QUEUE = 'n8n-events';
```

```ts
// integrations/n8n/n8n.queue.processor.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { N8N_QUEUE } from './n8n.constants';
import { N8nDispatcher } from './n8n.dispatcher';
import { N8nConfig } from './n8n.config';
import { N8nEventPayload } from './n8n.types';

@Processor(N8N_QUEUE)
export class N8nQueueProcessor extends WorkerHost {
  constructor(
    private readonly dispatcher: N8nDispatcher,
    private readonly cfg: N8nConfig,
  ) { super(); }

  async process(job: Job<N8nEventPayload>): Promise<void> {
    const path = this.cfg.resolveWebhookPath(job.data.event);
    if (!path) {
      // Evento sin webhook configurado: log y descartar (no reintentar).
      return;
    }
    await this.dispatcher.dispatch(path, job.data);
  }
}
```

Configuración de la cola al registrarla:

```ts
BullModule.registerQueue({
  name: N8N_QUEUE,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: false, // dejar fallos en cola para inspección manual
  },
});
```

### 5.5 Listeners

Un listener por familia de eventos. Recibe el evento de dominio, arma payload, encola.

```ts
// integrations/n8n/listeners/lead.listener.ts
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { N8N_QUEUE } from '../n8n.constants';
import { LeadQualifiedEvent } from '../../../common/events/lead.events';

@Injectable()
export class LeadEventsListener {
  constructor(@InjectQueue(N8N_QUEUE) private readonly queue: Queue) {}

  @OnEvent('lead.qualified', { async: true })
  async onLeadQualified(evt: LeadQualifiedEvent) {
    await this.queue.add(
      'lead.qualified',
      {
        event: evt.name,
        version: evt.version,
        eventId: evt.eventId,
        occurredAt: evt.occurredAt,
        traceId: evt.traceId,
        data: {
          leadId: evt.leadId,
          contactId: evt.contactId,
          conversationId: evt.conversationId,
          score: evt.score,
          detectedIntent: evt.detectedIntent,
          productOfInterest: evt.productOfInterest,
        },
      },
      { jobId: evt.eventId }, // idempotencia: BullMQ rechaza duplicados
    );
  }
}
```

### 5.6 Resolver de URLs por evento

```ts
// integrations/n8n/n8n.config.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class N8nConfig {
  constructor(private readonly cfg: ConfigService) {}

  private readonly map: Record<string, string | undefined> = {
    'lead.qualified': this.cfg.get('N8N_WEBHOOK_LEAD_QUALIFIED'),
    'conversation.handoff_requested': this.cfg.get('N8N_WEBHOOK_HANDOFF_REQUESTED'),
    'conversation.stalled': this.cfg.get('N8N_WEBHOOK_CONVERSATION_STALLED'),
    'task.followup_due': this.cfg.get('N8N_WEBHOOK_TASK_FOLLOWUP_DUE'),
    'quote.requested': this.cfg.get('N8N_WEBHOOK_QUOTE_REQUESTED'),
    'payment.intent_detected': this.cfg.get('N8N_WEBHOOK_PAYMENT_INTENT'),
  };

  resolveWebhookPath(eventName: string): string | undefined {
    return this.map[eventName];
  }
}
```

### 5.7 Propagación de traceId

Con `nestjs-cls`:

```ts
// common/trace/trace.module.ts
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'crypto';

ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    generateId: true,
    idGenerator: (req) =>
      (req.headers['x-trace-id'] as string) ?? randomUUID(),
    setup: (cls, req) => {
      cls.set('traceId', cls.getId());
    },
  },
});
```

En los servicios:

```ts
constructor(private readonly cls: ClsService) {}

// ...
const traceId = this.cls.get<string>('traceId');
this.emitter.emit('lead.qualified', new LeadQualifiedEvent(..., traceId));
```

---

## 6. Puntos de emisión exactos en el código actual

Esta es la sección más importante para retomar trabajo: dice **qué tocar y dónde** en los archivos que ya existen.

### 6.1 `src/webhook/webhook.service.ts`

Inyectar `EventEmitter2` + `ClsService` en el constructor.

| Línea actual | Evento a emitir | Después de |
|---|---|---|
| 122 (`Mensaje recibido` log, justo después del `create` del INBOUND) | `conversation.message_received` *(opcional, alto volumen — evaluar)* | Crear el `savedMessage` INBOUND |
| 176 (después del `create` del OUTBOUND) | `conversation.response_sent` *(opcional, alto volumen)* | Guardar mensaje OUTBOUND |
| 302 (final de `createAutoHandoff`) | `conversation.handoff_requested` | Después de `prisma.humanHandoff.create` |
| 328–330 (final de `updateConversationState`) | Disparar `lead.qualified` **condicionalmente** cuando `hermesResponse.detectedIntent` sea de alta intención y/o `closeScore >= threshold` | Tras upsert de state |

Para `lead.qualified` desde el webhook hace falta resolver el `leadId`: hoy no se crea un Lead automáticamente al recibir mensaje. **Decisión a tomar (ver §9):** o el webhook crea un Lead `NEW`/`QUALIFIED` cuando detecta intención, o el evento se emite con `leadId: null` y n8n filtra. Recomendado: crear/upsert Lead `QUALIFIED` y emitir.

### 6.2 `src/leads/leads.service.ts`

| Método | Línea | Evento |
|---|---|---|
| `create` | 14 | `lead.created` después del `prisma.lead.create` |
| `update` | 65 | `lead.qualified` si el `stage` pasa a `QUALIFIED`; `lead.won` (a futuro) si pasa a `WON` |

### 6.3 `src/handoff/handoff.service.ts`

| Método | Línea | Evento |
|---|---|---|
| `create` | 17 | `conversation.handoff_requested` (este es el "punto de verdad", el webhook solo lo dispara cuando llama al service) |

> Importante: hoy `webhook.service.ts` no llama a `handoff.service.ts.create()`, escribe directo en Prisma. Refactor sugerido (opcional, mejora la arquitectura): que `createAutoHandoff` llame a `HandoffService.create(...)` y el evento se emita en un único lugar.

### 6.4 `src/tasks/tasks.service.ts`

- En el `create` de Task con `dueAt`: programar un job retrasado en la cola para emitir `task.followup_due` cuando llegue el momento. Esto reemplaza tener un cron.
- Alternativa más simple: cron que cada N minutos busca tasks vencidas y emite el evento. Si ya hay BullMQ, usar `Queue.add(..., { delay })` directamente.

### 6.5 Detección de "conversación estancada"

No hay disparador natural en el flujo síncrono. Opciones:

- Cron job en BullMQ (`@Cron` de `@nestjs/schedule`, o `repeatable jobs` de BullMQ) que cada 30 min busque conversaciones `ACTIVE` cuyo último mensaje INBOUND tenga > X horas sin OUTBOUND posterior, y emita `conversation.stalled`.
- Implementar en una fase posterior (Etapa 3).

### 6.6 Detección de intent de pago / quote

Estos eventos no existen aún como concepto. Se derivan del `detectedIntent` que devuelve Hermes en el webhook. Mapping sugerido:

- `detectedIntent === 'payment_inquiry'` → `payment.intent_detected`.
- `detectedIntent === 'quote_request'` → `quote.requested`.

Se emiten desde el webhook después del paso 6 (respuesta de Hermes), antes o en paralelo a `updateConversationState`.

---

## 7. Seguridad

### 7.1 Hacia n8n (outbound)

- HMAC SHA-256 del body completo con `N8N_HMAC_SECRET`. En el header `X-Hermes-Signature: sha256=<hex>`.
- En n8n, el primer nodo del workflow debe ser una **Function** que verifique la firma antes de procesar. Si falla, return 401.
- Nunca incluir secretos del backend en el payload (tokens Meta, JWT_SECRET, etc.).

### 7.2 Hacia el backend (inbound desde n8n)

Algunos workflows van a querer escribir de vuelta al backend (ej. registrar resultado de la automatización). Crear endpoints específicos bajo `/api/integrations/n8n/*` con:

- API key compartida (`N8N_CALLBACK_TOKEN` en `.env`), validada por un guard NestJS.
- Idempotencia por `eventId` para que reintentos de n8n no dupliquen escritura.

### 7.3 Idempotencia

- En el dispatcher: el `jobId` de BullMQ es el `eventId`. BullMQ rechaza jobs con jobId duplicado.
- En el workflow de n8n: usar el `eventId` para verificar contra un store de "ya procesados" (si el workflow tiene side effects no idempotentes, como mandar SMS).
- En callbacks desde n8n al backend: el endpoint debe tolerar el mismo `eventId` llegando dos veces (upsert + no-op).

### 7.4 Datos sensibles en payload

- Números de teléfono OK (negocio los necesita).
- Nunca enviar contenido completo de conversación a workflows externos (Slack, Sheets) a menos que el flujo lo requiera explícitamente y el cliente haya consentido.
- Si se loguean payloads, redactar campos sensibles.

---

## 8. Lado n8n

### 8.1 Instalación sugerida (VPS)

`docker-compose.yml` (sumar al stack existente):

```yaml
services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:5678:5678"
    environment:
      - N8N_HOST=n8n.tu-dominio.com
      - N8N_PROTOCOL=https
      - N8N_PORT=5678
      - WEBHOOK_URL=https://n8n.tu-dominio.com/
      - GENERIC_TIMEZONE=America/Guayaquil
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - DB_POSTGRESDB_DATABASE=n8n
      - DB_POSTGRESDB_USER=n8n
      - DB_POSTGRESDB_PASSWORD=<secret>
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=admin
      - N8N_BASIC_AUTH_PASSWORD=<secret>
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      - postgres
```

Reverse proxy (Traefik/Nginx/Caddy) hace TLS pública y restringe basic auth solo a panel; los webhooks quedan accesibles para el backend.

### 8.2 Workflows iniciales (Lote 1) — alcance reducido

Por decisión del usuario (§9 punto 5), el Lote 1 se limita a **notificaciones por Telegram al vendedor**. Slack/Trello/email/Sheets quedan pospuestos hasta que exista el dashboard administrativo (§9.1).

Credenciales mínimas a configurar en n8n:

- **Telegram Bot Token**: crear bot con `@BotFather` en Telegram, copiar el token.
- **Chat ID(s) del vendedor**: el `chat_id` del vendedor o del grupo de ventas. Para obtenerlo, el vendedor manda un mensaje al bot y se consulta `https://api.telegram.org/bot<TOKEN>/getUpdates`.

Workflows del Lote 1:

1. **`lead-qualified-notify-vendor`** (`/webhook/lead-qualified`)
   - Nodo 1 — Webhook (POST).
   - Nodo 2 — Function: verificar HMAC `X-Hermes-Signature` contra `N8N_HMAC_SECRET`. Si falla, return 401.
   - Nodo 3 — IF: continuar solo si `data.score >= 0.7`.
   - Nodo 4 — Telegram (Send Message):
     ```
     🎯 Lead calificado
     Contacto: {{ $json.data.contactId }}
     Producto: {{ $json.data.productOfInterest }}
     Score: {{ $json.data.score }}
     Intent: {{ $json.data.detectedIntent }}
     Trace: {{ $json.traceId }}
     ```
   - Nodo 5 — HTTP Request: POST a `/api/integrations/n8n/lead-qualified/ack` con `eventId` para confirmar procesamiento.

2. **`handoff-requested-notify-vendor`** (`/webhook/handoff-requested`)
   - Nodo 1 — Webhook.
   - Nodo 2 — Function: verificar HMAC.
   - Nodo 3 — Telegram:
     ```
     🚨 Handoff solicitado
     Conversación: {{ $json.data.conversationId }}
     Razón: {{ $json.data.reason }}
     Detalle: {{ $json.data.reasonDetail }}
     ```
   - Nodo 4 — HTTP Request: POST a `/api/integrations/n8n/handoff-requested/ack`.

**Workflows pospuestos** (no implementar en Lote 1, dejados anotados para fases futuras):

- `conversation-stalled-followup` → cuando se implemente Etapa 4 del roadmap.
- `daily-sales-summary` → cuando exista dashboard o se decida que email/Telegram sirve.
- `campaign-lead-sync-to-sheet` → cuando se justifique.
- `quote-requested-*`, `payment-intent-*` → pueden reusar el mismo patrón Telegram del Lote 1 cuando se activen.

### 8.3 Convenciones para n8n

- Nombre del workflow == nombre del webhook (1:1).
- Cada workflow versionado en su descripción (`v1.0`, etc.).
- Variables sensibles via n8n Credentials, no en nodos.
- Exportar workflows como JSON y guardarlos en `D:\Documentos\Hermes\n8n-workflows\` para versionado.
- Todos los workflows del Lote 1 usan la misma credencial Telegram (`Telegram Hermes Bot`).

---

## 9. Decisiones resueltas

Resueltas el 2026-06-27 en conversación con el usuario.

1. **Lead automático desde el webhook**: **SÍ**. Cuando Hermes detecta alta intención (intent de compra, pago, cotización) y/o `closeScore` por encima de umbral, el webhook hace upsert de Lead con stage `QUALIFIED` y emite `lead.qualified`. Umbral inicial sugerido: `closeScore >= 0.7` o `detectedIntent ∈ ['pricing_request', 'quote_request', 'payment_inquiry']`. Ajustable por config.
2. **Hosting de n8n**: **mismo VPS** que el backend. Compartido con el `docker-compose.yml`. Se asume el trade-off de destino compartido a cambio de costo cero adicional.
3. **Eventos de alto volumen (`message_received`, `response_sent`)**: **emitirlos con muestreo/batching**. Estrategia inicial: usar el `limiter` de BullMQ (`max: 60, duration: 60_000` por evento) para tope de 60/min hacia n8n. Si volumen real lo justifica, agregar batch (acumular N eventos y mandar un job con array).
4. **Refactor de `createAutoHandoff`**: **SÍ se hace** en Etapa 2. El método del webhook deja de escribir directo a Prisma y llama a `HandoffService.create(...)`. El evento `conversation.handoff_requested` se emite **solo** en `HandoffService.create`, sirviendo tanto para handoff automático (webhook) como manual (API). Detalle de implementación en §6.3.
5. **Destinos de los workflows de n8n (Lote 1)**: **solo Telegram al vendedor** por ahora. El plan original mencionaba Slack/Trello/email; todo eso queda fuera de alcance hasta que exista el dashboard administrativo (ver §9.1). El daily-sales-summary también se pospone.

### 9.1 Visión futura — dashboard administrativo

A mediano plazo se construirá un **dashboard propio para uso administrativo de vendedores**. El dashboard será una app separada (probablemente React + Vite) que se conectará **directamente al backend** (no a través de n8n), consumirá los endpoints REST existentes y recibirá actualizaciones en tiempo real vía WebSocket.

Implicancias para el plan actual:

- **Hoy NO se implementa** ni el dashboard ni el `WebSocketGateway`. Foco corto plazo: integración n8n + notificación Telegram.
- **La arquitectura de eventos** que se construye en este plan (DomainEvent → EventEmitter2 → listeners) está pensada para que el día que se sume el dashboard, **agregar un nuevo listener (`WebSocketGateway`) que escuche los mismos eventos** no requiera tocar los servicios de dominio. Solo es sumar un consumer más al event bus.
- **Alcance reducido de n8n**: con dashboard, n8n se queda solo para integraciones realmente externas (notificaciones a dispositivo personal del vendedor cuando no está en el dashboard, reportes a email/Sheets, APIs de terceros). Esto se reflejará cuando llegue el momento.

Por ahora, n8n + Telegram es el canal único de notificación al equipo de ventas.

---

## 10. Roadmap por etapas

### Etapa 0 — Preparación (sin código nuevo de eventos)

- [x] Confirmar decisiones de §9 con el usuario. *(Resueltas 2026-06-27.)*
- [x] Agregar Redis y n8n al `docker-compose.yml` del backend. *(Redis ya estaba; n8n agregado 2026-06-27 con volumen `hermes_n8n_data`, basic auth `admin / hermes_n8n_admin_change_me`, puerto 5678.)*
- [x] Agregar variables nuevas a `.env.example`. *(Hecho 2026-06-27: bloque n8n + Lead qualification + Telegram comment.)*
- [x] Crear el archivo `.env` real a partir de `.env.example` y completar secretos. *(Hecho 2026-06-28 directo en el VPS: `/var/www/hermes/hermes-backend/.env`, `chmod 600`. Secretos `JWT_SECRET`, `N8N_HMAC_SECRET`, `N8N_CALLBACK_TOKEN` generados con `openssl rand -hex 32`. `META_WEBHOOK_VERIFY_TOKEN=hermes_n8n_whatsapp_2026`. URLs internas usan hostnames de servicio Docker: `postgres`, `redis`, `n8n`.)*
- [x] Agregar servicio `app` (NestJS) al `docker-compose.yml` y subir todo el repo a GitHub (`https://github.com/undercodeec/hermes_n8n.git`). *(Hecho 2026-06-28. Puerto 3003 host↔contenedor, `depends_on` postgres/redis/n8n con healthchecks. Dockerfile `EXPOSE 3000` → `EXPOSE 3003`.)*
- [x] `docker compose build app` exitoso en el VPS tras regenerar `package-lock.json` (estaba desincronizado: faltaban `@emnapi/core` y `@emnapi/runtime`). Se regeneró con `docker run --rm -v "$(pwd)":/app -w /app node:20-alpine npm install --package-lock-only`. Reconciliado: el lock regenerado se commiteó desde el VPS y se bajó a local con `git pull` (commit `08e324a`).
- [x] `docker compose up -d` ejecutado. 3 contenedores `healthy`: `hermes-postgres`, `hermes-redis`, `hermes-n8n`.
- [x] **`hermes-app` levantado**. Bloqueador era Prisma 5.22 + libssl en Alpine (4 vueltas de diagnóstico — ver §14 revisión 5). Resuelto cambiando base image a `node:20-bookworm-slim` + `apt-get install openssl ca-certificates`.
- [x] Migraciones Prisma aplicadas. La inicial se generó con `migrate dev --name init` en el contenedor, se copió al host con `docker compose cp` y se commiteó (`prisma/migrations/20260628184421_init/`).
- [x] Smoke test webhook localmente en el VPS: `curl "http://localhost:3003/webhooks/meta/whatsapp?..."` → `test123`. OK.
- [x] Nginx reverse proxy configurado para `hermes.undercodeec.com` → `127.0.0.1:3003`. `nginx -t` OK. `curl "http://hermes.undercodeec.com/webhooks/..."` → `test123`. OK.
- [x] **HTTPS desplegado** (2026-06-28). `certbot --nginx` OK, certificado activo, `curl` HTTPS retorna `test123`.
- [x] Registrado el webhook en Meta Developers Dashboard (2026-06-28). Suscripciones: `messages`, `message_status`, `message_template_status_update`, `message_template_quality_update`. `META_PHONE_NUMBER_ID` ya en `.env` del VPS.
- [x] **Acceder al panel de n8n y crear cuenta inicial (2026-06-29).** Se expuso n8n en subdominio propio `n8n.undercodeec.com` con Nginx (proxy a `127.0.0.1:5678`, headers WebSocket Upgrade, `proxy_read_timeout 3600s`) + TLS via `certbot --nginx`. `N8N_SECURE_COOKIE` quedó en `true` (HTTPS). DNS: registro A `n8n` → `96.44.174.213`. Acceso al panel: `https://n8n.undercodeec.com`. *Detalle del proceso: el SSH del VPS corre en puerto **2223** (no 22); el túnel SSH temporal con cookie `false` se descartó a favor del subdominio permanente.*
- [x] **Workflow dummy `ping-test` creado y activo (2026-06-29).** Nodo Webhook POST, path `ping`, Respond `Immediately` 200. Validado en producción por HTTPS: `curl -X POST https://n8n.undercodeec.com/webhook/ping` → `200`. (Confirma el camino completo Nginx + TLS + n8n para la URL de producción.)
- [x] **Bot de Telegram creado con `@BotFather` (2026-06-29).** Token guardado por el usuario (fuera de banda, no en el repo).
- [x] **`chat_id` obtenido (2026-06-29)** vía `https://api.telegram.org/bot<TOKEN>/getUpdates` tras escribirle al bot. Guardado a mano (se usará en el nodo Telegram Send Message de cada workflow, campo Chat ID).
- [x] **Credencial Telegram registrada en n8n (2026-06-29)**: nombre `Telegram Hermes Bot`, tipo Telegram API, Base URL por defecto `https://api.telegram.org`, conexión testeada OK.

#### Notas sobre la configuración aplicada

- **Variables Redis**: el plan en §3.3 listaba `REDIS_HOST/PORT/PASSWORD`, pero el `.env.example` ya tenía `REDIS_URL`. Se mantuvo `REDIS_URL` por simplicidad (ioredis acepta ambas formas). La configuración de BullMQ usará `REDIS_URL`.
- **n8n con SQLite**: por defecto n8n usa SQLite dentro del volumen `hermes_n8n_data`. Suficiente para volumen bajo. Si se necesita Postgres compartido, crear DB `n8n` aparte y setear `DB_TYPE=postgresdb` + `DB_POSTGRESDB_*` en el compose.
- **Cookie segura desactivada** (`N8N_SECURE_COOKIE=false`): necesario porque n8n local corre sobre HTTP. En producción detrás de TLS hay que removerla.
- **Basic auth por defecto débil** (`hermes_n8n_admin_change_me`): cambiar en producción. En local sirve para empezar.

### Etapa 1 — Infraestructura de eventos en el backend

- [x] `npm install` de las 5 deps nuevas (2026-06-29). Versiones reales instaladas: `@nestjs/event-emitter@^3.1.0`, `@nestjs/bullmq@^11.0.4`, `bullmq@^5.79.2`, `ioredis@^5.11.1`, `nestjs-cls@^6.2.1` (más nuevo que el ^4 del plan; API `ClsModule.forRoot` compatible).
- [x] Crear `common/events/` con `domain-event.ts` y `ping.event.ts` (`PingEvent`).
- [x] Crear `common/trace/trace.module.ts` con `nestjs-cls` configurado (genera/propaga `traceId` desde header `x-trace-id`).
- [x] Crear `integrations/n8n/` con `n8n.module.ts`, `n8n.dispatcher.ts`, `n8n.config.ts`, `n8n.constants.ts`, `n8n.types.ts`, `n8n.queue.processor.ts`, `n8n.controller.ts` (test) y `listeners/ping.listener.ts`.
- [x] Registrar `BullModule.forRootAsync()` global (conexión parseada de `REDIS_URL`, `maxRetriesPerRequest: null`) + `BullModule.registerQueue({ name: N8N_QUEUE })` dentro de `N8nModule`.
- [x] Registrar `EventEmitterModule.forRoot()` en `app.module.ts`.
- [x] Importar `N8nModule` (rol de `IntegrationsModule`) + `TraceModule` en `app.module.ts`.
- [x] Endpoint admin temporal `POST /internal/test-event` que emita un `PingEvent`. **`nest build` OK (compila limpio).**
- [x] **Validación end-to-end OK (2026-06-29)** en el VPS: `POST /internal/test-event` con header `X-Internal-Token` → `201 {"emitted":true,...}` + log `[N8nDispatcher] Dispatched ping (<eventId>)`. Cadena completa verificada: emit → listener → BullMQ → processor → dispatcher → POST a n8n (2xx). `traceId` propagado. **Pendiente menor**: confirmar visualmente la ejecución en n8n → Executions del workflow `ping-test`.

### Etapa 2 — Primer evento real: `conversation.handoff_requested`

- [x] Crear `ConversationHandoffRequestedEvent` (`common/events/conversation.events.ts`). Campos: `handoffId`, `conversationId`, `contactId`, `reason`, `reasonDetail?`, `assignedAgentId?`, `traceId?`.
- [x] Listener `integrations/n8n/listeners/conversation.listener.ts` (`ConversationListener`) que encola a BullMQ con `jobId: eventId`. Registrado en `n8n.module.ts`.
- [x] **Refactor confirmado**: `webhook.service.ts:createAutoHandoff` ya no escribe a Prisma directo; llama a `HandoffService.create(...)`. `HandoffService` inyectado en `WebhookService`, `HandoffModule` importado en `WebhookModule`.
- [x] Emitir `ConversationHandoffRequestedEvent` desde `HandoffService.create` — único punto de emisión, cubre handoff manual y automático. `traceId` leído de `ClsService` (guard con `isActive()`).
- [x] `nest build` OK (compila limpio).
- [ ] Workflow en n8n `handoff-requested-notify-vendor` con verificación HMAC + Telegram (ver §8.2). *(manual, en el panel)*
- [ ] Agregar `N8N_WEBHOOK_HANDOFF_REQUESTED=/webhook/handoff-requested` al `.env` del VPS (hoy resuelve a `undefined` → el processor descarta el job sin reintentar). Sin esta var el evento se encola pero no se despacha.
- [ ] Desplegar al VPS (`git pull` + rebuild) — Redis/n8n viven en la red Docker del VPS.
- [ ] Test end-to-end manual: enviar mensaje con keyword de handoff → ver mensaje en Telegram del vendedor.
- [ ] Test de caída: apagar n8n, disparar handoff, verificar que BullMQ reintenta con backoff.

### Etapa 3 — Segundo evento real: `lead.qualified`

- [ ] Crear `LeadQualifiedEvent`.
- [ ] Listener.
- [ ] Emitirlo desde `LeadsService.update` cuando stage pasa a `QUALIFIED`.
- [ ] **Lógica de calificación automática confirmada** (§9 punto 1): en `webhook.service.ts`, después de la respuesta de Hermes, evaluar si `closeScore >= 0.7` o `detectedIntent ∈ ['pricing_request', 'quote_request', 'payment_inquiry']`. Si sí, upsert Lead con stage `QUALIFIED` y emitir el evento. Umbral configurable vía env (`LEAD_QUALIFICATION_SCORE_THRESHOLD`).
- [ ] Workflow en n8n `lead-qualified-notify-vendor`.
- [ ] Validación end-to-end: simular mensaje con intent de compra → verificar Lead QUALIFIED en DB + mensaje en Telegram.

### Etapa 4 — Conversation stalled + task followup

- [ ] Job repetible BullMQ que busque conversaciones estancadas.
- [ ] Listener + workflow.
- [ ] Implementar `task.followup_due` con `Queue.add(..., { delay })`.

### Etapa 5 — Resto de eventos (mismo patrón Telegram)

- [ ] `quote.requested`, `payment.intent_detected`.
- [ ] Workflows correspondientes en n8n reusando el patrón Telegram del Lote 1.
- [ ] *Pospuestos hasta dashboard*: `daily-sales-summary`, `campaign-lead-sync-to-sheet`. No implementar todavía.

### Etapa 6 — Madurez operativa

- [ ] Dashboard de BullMQ (Bull Board, opcional).
- [ ] Alertas si DLQ > N jobs.
- [ ] Versionado formal de payloads y proceso para incrementar versión.
- [ ] Documentar contratos de eventos en un `events-catalog.md` separado.
- [ ] Evaluar migración a outbox pattern si la criticidad lo justifica.

---

## 11. Checklist accionable para retomar el trabajo

Si abrís este documento en una sesión futura y querés arrancar, este es el orden:

```
[ ] 1. Releer §1 para confirmar estado.
[ ] 2. Releer §9, resolver decisiones pendientes con el usuario.
[ ] 3. Si Etapa 0 no está hecha → hacer Etapa 0 entera.
[ ] 4. Si Etapa 1 no está hecha → implementar §3.1 + §4 + §5 (skeleton).
[ ] 5. Validar con PingEvent antes de tocar eventos reales.
[ ] 6. Implementar Etapas 2 y 3 (handoff + lead.qualified) — alto valor inmediato.
[ ] 7. El resto en orden, sin saltar.
```

### Comando rápido de instalación (Etapa 1)

```bash
cd D:\Documentos\Hermes\hermes-backend
npm install @nestjs/event-emitter @nestjs/bullmq bullmq ioredis nestjs-cls
```

### Variables que tienen que existir antes de probar (Etapa 1)

`REDIS_HOST`, `REDIS_PORT`, `N8N_BASE_URL`, `N8N_HMAC_SECRET`, `N8N_INTEGRATION_ENABLED=true`.

### Cómo validar Etapa 1 está OK

1. Levantar Redis (`docker-compose up redis`).
2. Levantar n8n con workflow dummy `/webhook/ping`.
3. Levantar backend.
4. Hacer `POST /internal/test-event`.
5. Ver log `Dispatched ping ...` en backend.
6. Ver ejecución en n8n.
7. Verificar que el header `X-Hermes-Signature` viene firmado y el workflow lo valida correctamente.

---

## 12. Riesgos conocidos y cómo se mitigan

| Riesgo | Mitigación |
|---|---|
| Cache de jobs en Redis se llena | `removeOnComplete: { age, count }` ya configurado |
| n8n caído por horas | BullMQ retiene jobs, retry exponencial; alerta si DLQ crece |
| Event storm (cliente enviando muchos mensajes) genera muchos eventos | Throttling en BullMQ (`limiter`) por evento; muestreo de eventos de alto volumen |
| HMAC secret filtrado | Rotación: cambiar `N8N_HMAC_SECRET` en backend + en workflows simultáneamente |
| Refactor de webhook rompe handoff | Tests E2E del webhook antes de refactor (no existen hoy — escribir antes de Etapa 2) |
| n8n y backend desacoplados pero contractos no versionados | `version: '1.0'` en payload desde el día 1; documentar cambios |
| `traceId` no se propaga porque ClsService no está en contexto async (BullMQ worker) | El traceId se serializa dentro del payload del job, no se lee de CLS dentro del worker |
| Latencia adicional aunque sea por la cola | `queue.add` es no-bloqueante (Redis local < 5ms); el flujo crítico no espera al dispatch |

---

## 13. Referencias internas

- Guía maestra: `D:\Documentos\Hermes\guia-hermes-vps-meta-whatsapp.md`.
- Propuesta original n8n (con la que diverge este plan en §2.1): `D:\Documentos\Hermes\integracion-n8n-backend-hermes.md`.
- Código base del flujo síncrono actual: `hermes-backend/src/webhook/webhook.service.ts`.
- Schema de DB: `hermes-backend/prisma/schema.prisma`.
- Módulos cargados hoy: `hermes-backend/src/app.module.ts`.

---

## 14. Bitácora de cambios

- **2026-06-27 (creación):** versión inicial del plan.
- **2026-06-27 (revisión 1):** resueltas las 5 decisiones de §9. Lead automático SÍ. n8n en mismo VPS. Eventos de alto volumen con muestreo. Refactor `createAutoHandoff` confirmado. Workflows Lote 1 limitados a Telegram al vendedor (Slack/email/Sheets pospuestos). Agregada §9.1 con visión futura de dashboard administrativo (no se implementa ahora pero la arquitectura de eventos lo soporta sin cambios mayores). Actualizado §8.2 con detalle de nodos Telegram. Actualizado §10 (Etapas 2, 3, 5) para reflejar alcance Telegram-only y refactor confirmado. Sumadas vars `LEAD_QUALIFICATION_*` a §3.3.
- **2026-06-27 (revisión 2 — inicio Etapa 0):** servicio `n8n` agregado a `hermes-backend/docker-compose.yml` (image `n8nio/n8n:latest`, puerto 5678, basic auth, volumen `hermes_n8n_data`). Bloque completo de variables n8n + `LEAD_QUALIFICATION_*` + nota Telegram agregado a `hermes-backend/.env.example`. Decidido usar `REDIS_URL` existente en lugar de `REDIS_HOST/PORT/PASSWORD` por simplicidad. Pendientes de Etapa 0: crear `.env` real, levantar contenedores, crear bot Telegram, registrar credencial en n8n.
- **2026-06-28 (revisión 3 — deploy a VPS para verificación de webhook Meta):**
  - `docker-compose.yml` ampliado con servicio `app` (NestJS, container `hermes-app`, `ports: 3003:3003`, `env_file: .env`, `depends_on` postgres/redis/n8n con healthchecks). PostgreSQL/Redis/n8n mantienen sus puertos.
  - `Dockerfile` actualizado: `EXPOSE 3000` → `EXPOSE 3003` para alinear con `PORT=3003`.
  - `.gitignore` creado en la raíz del proyecto (excluye `.env`, `node_modules/`, `dist/`, `*.md`). Se inicializó repo git y se publicó en `https://github.com/undercodeec/hermes_n8n.git`, rama `main`.
  - Repo clonado en VPS RackNerd en `/var/www/hermes/`. Subdominio `hermes.undercodeec.com` ya apunta al VPS; Nginx instalado pero todavía sin site config para este subdominio.
  - `.env` real creado en el VPS (`/var/www/hermes/hermes-backend/.env`, `chmod 600`) con secretos generados localmente. URLs internas usan hostnames de Docker (`postgres`, `redis`, `n8n`) y `HERMES_API_URL` apunta a `host.docker.internal:8080`.
  - Próximos pasos inmediatos (orden): instalar Docker en el VPS → `docker compose up -d` → migraciones Prisma → smoke test del webhook localmente → configurar Nginx + Let's Encrypt → registrar webhook en Meta Dashboard (verify token `hermes_n8n_whatsapp_2026`) → recibir `META_PHONE_NUMBER_ID`.
- **2026-06-28 (revisión 4 — primer up, app crashea):**
  - Docker 29.6.1 + Compose v5.2.0 instalados en el VPS.
  - Línea `version: '3.8'` removida del `docker-compose.yml` (obsoleta en Compose v2/v5). Aplicado en local + via `sed -i` en el VPS.
  - Primer intento de build falló: `package-lock.json` desincronizado con `package.json` (faltaban `@emnapi/core@1.11.1` y `@emnapi/runtime@1.11.1`). Resuelto regenerando el lock en el VPS con `docker run --rm -v "$(pwd)":/app -w /app node:20-alpine npm install --package-lock-only`. El lock regenerado **vive solo en el VPS**, no está en GitHub ni en local — pendiente reconciliar.
  - Otro paso intermedio que NO está en local: `.env` se creó en el VPS con un `cat > .env <<EOF` que incluye `$(openssl rand -hex 32)` para `JWT_SECRET`, `N8N_HMAC_SECRET` y `N8N_CALLBACK_TOKEN`. Los hashes resultantes son los únicos válidos para producción y nunca se subirán al repo (`.env` está en `.gitignore`). Si se rehace el VPS desde cero, regenerar y guardar fuera de banda (gestor de secretos).
  - Build OK en el segundo intento (~64s). `docker compose up -d`: 3 servicios `healthy` (postgres, redis, n8n) + 1 contenedor `hermes-app` en bucle de reinicio.
  - **Bloqueador al cerrar sesión**: `hermes-app` con status `Restarting (1)`. Aún no se leyeron los logs. Al retomar:
    1. `cd /var/www/hermes/hermes-backend && docker compose logs app --tail=80`.
    2. Diagnosticar el error (sospechas: conexión a Postgres, Prisma migrate no ejecutado, env var faltante).
    3. Si era falta de migraciones: `docker compose exec app npx prisma migrate deploy`.
    4. Smoke test: `curl "http://localhost:3003/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=hermes_n8n_whatsapp_2026&hub.challenge=test123"` → debe responder `test123`.
    5. Continuar con Nginx + Let's Encrypt + registro en Meta Dashboard.

- **2026-06-28 (revisión 5 — desbloqueo de Etapa 0, app levantada, Nginx OK):**
  - **Diagnóstico del crash de `hermes-app`** (4 iteraciones, todas commiteadas):
    1. Causa raíz: `PrismaClientInitializationError: Unable to require libquery_engine-linux-musl.so.node` + `Details: Error loading shared library libssl.so.1.1`. Prisma 5.22 genera por default `binaryTarget = "native"` que en Alpine resuelve a `linux-musl` (libssl 1.1), pero `node:20-alpine` actual viene con libssl 3.x.
    2. Intento 1 (commit `3143ae4`): agregar `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` a `schema.prisma` + remover `version: '3.8'` del compose. Falló — el warning "Prisma failed to detect libssl/openssl version" seguía, y Prisma defaulteaba a 1.1.x.
    3. Intento 2 (commit `d922df5`): `RUN apk add --no-cache openssl` en ambas stages del Dockerfile para que Prisma pudiera detectar libssl. Falló igual.
    4. Intento 3: rebuild reportaba mismo error. **Causa real descubierta**: `git pull` en VPS abortó por conflicto local en `docker-compose.yml` (la edición `sed -i` que removía `version: '3.8'`, ya en repo). Los dos commits anteriores nunca llegaron al VPS — los rebuilds usaban el Dockerfile viejo. Resuelto con `git checkout -- docker-compose.yml && git pull`.
    5. Intento 4 (commit `72a1b86`): switch a `node:20-bookworm-slim` (Debian) + `apt-get install openssl ca-certificates` + revertido `binaryTargets` (en Debian `native` resuelve a `debian-openssl-3.0.x` sin override). Build con `--no-cache` (~79s) → `Nest application successfully started` ✅. Imagen ~150MB más grande que Alpine; trade-off aceptable a cambio de runtime estable de Prisma.
  - **Migraciones Prisma**: `prisma/migrations/` estaba vacío. Se generó la inicial con `docker compose exec app npx prisma migrate dev --name init` → `20260628184421_init/migration.sql` (357 líneas, todo el schema). Como el directorio `prisma/` no está en volume mount, los archivos quedaron solo dentro del contenedor; se copiaron al host con `docker compose cp app:/app/prisma/migrations ./prisma/`. Commit `08e324a` (incluye también el `package-lock.json` regenerado del VPS, que en revisión 4 quedó desincronizado).
  - **Nginx site config** creado en `/etc/nginx/sites-available/hermes.undercodeec.com` (proxy a `127.0.0.1:3003`, `client_max_body_size 10M`, `proxy_read_timeout 60s`). Symlink en `sites-enabled/` ya existía de antes (no rompió). `nginx -t` OK, reload OK. Smoke test `curl "http://hermes.undercodeec.com/webhooks/meta/whatsapp?..."` → `test123` ✅.
  - **Pendiente al cierre**: ejecutar `certbot --nginx` para TLS + registrar webhook en Meta Dashboard. Sin TLS, Meta no acepta la verificación.
  - **Decisión secundaria — migración a pnpm**: pedida por el usuario por escalabilidad + incidentes recientes en npm registry. Aclarado en sesión: pnpm consume del mismo registry; la mitigación de supply chain real es `minimumReleaseAge` en `.npmrc`. Decidido **NO** interleaverla con el fix actual. Se hará en rama propia después de cerrar Etapa 0. Guardado en memoria como `project-pnpm-migration` con los pasos concretos (incluye `shamefully-hoist=true` para NestJS, `corepack enable && pnpm install --frozen-lockfile` en el Dockerfile, validación de Prisma con pnpm).
  - **Próximos pasos inmediatos al retomar** (orden estricto):
    1. `sudo certbot --nginx -d hermes.undercodeec.com --non-interactive --agree-tos -m undercodeec@gmail.com --redirect`.
    2. Validar `curl "https://hermes.undercodeec.com/webhooks/meta/whatsapp?..."` → `test123`.
    3. Registrar webhook en Meta Developers Dashboard. Suscribirse a `messages`, `message_status`, `message_template_status_update`.
    4. Recibir `META_PHONE_NUMBER_ID` y completarlo en `.env` del VPS.
    5. Acceder al panel de n8n (`http://localhost:5678` con basic auth) y crear cuenta inicial + workflow dummy `/webhook/ping`.

- **2026-06-29 (revisión 6 — panel n8n accesible vía subdominio TLS):**
  - Creada la cuenta owner de n8n. El acceso inicial se intentó por túnel SSH (`ssh -L 5678:localhost:5678 root@... -p 2223`) tras detectar que el SSH del VPS corre en el puerto **2223**, no 22 (por eso el primer túnel daba `Connection timed out`). Para el login por HTTP del túnel hubo que poner `N8N_SECURE_COOKIE: 'false'` temporalmente.
  - Decisión del usuario: en lugar de seguir con túnel + cookie insegura, **exponer n8n permanentemente** en `n8n.undercodeec.com`. Se creó registro A `n8n` → `96.44.174.213`, site Nginx con soporte WebSocket (`Upgrade`/`Connection upgrade`, `proxy_read_timeout 3600s`) y certificado TLS con `certbot --nginx`. `N8N_SECURE_COOKIE` revertido a `true`.
  - El compose ya tenía la config alineada (`N8N_HOST=n8n.undercodeec.com`, `WEBHOOK_URL=https://n8n.undercodeec.com/`, `N8N_PROXY_HOPS=1`).
  - **Pendientes de Etapa 0 al cierre**: (1) crear workflow dummy `/webhook/ping` que devuelva 200, (2) crear bot Telegram con `@BotFather` [tarea usuario], (3) obtener `chat_id` del vendedor vía `getUpdates` [tarea usuario], (4) registrar credencial Telegram en n8n.

- **2026-06-29 (revisión 7 — ETAPA 0 COMPLETA):** cerrados los 4 pendientes que quedaban. Workflow dummy `ping-test` activo y validado por HTTPS (`/webhook/ping` → 200). Bot de Telegram creado, `chat_id` obtenido y credencial `Telegram Hermes Bot` registrada en n8n (conexión OK). **Toda la infraestructura de Etapa 0 está lista.** Próximo: Etapa 1 — instalar las 5 deps npm (`@nestjs/event-emitter @nestjs/bullmq bullmq ioredis nestjs-cls`) y crear el skeleton de eventos (`common/events/`, `common/trace/`, `integrations/n8n/`). Nota: la migración a pnpm sigue pendiente como rama propia ([[project-pnpm-migration]]) y conviene decidir si se hace **antes** de instalar las deps de Etapa 1 para no rehacer el lockfile dos veces.

- **2026-06-29 (revisión 8 — Etapa 1: skeleton de eventos implementado):** decidido seguir con npm (no migrar a pnpm todavía). Instaladas las 5 deps. Creados: `common/events/{domain-event,ping.event}.ts`, `common/trace/trace.module.ts`, y todo `integrations/n8n/` (`n8n.{module,dispatcher,config,constants,types,queue.processor,controller}.ts` + `listeners/ping.listener.ts`). Wireado en `app.module.ts`: `TraceModule`, `EventEmitterModule.forRoot()`, `BullModule.forRootAsync()` y `N8nModule`.
  - **Detalle técnico — conexión Redis a BullMQ**: `bullmq` trae su propia copia anidada de `ioredis`, incompatible en tipos con la `ioredis` top-level. Pasar una instancia `new IORedis(...)` rompía el build (TS2322). Solución: parsear `REDIS_URL` con `new URL()` y pasar opciones planas `{ host, port, password, maxRetriesPerRequest: null }` a `BullModule.forRootAsync`.
  - **Detalle — webhook del ping**: `N8nConfig` mapea `ping` → `N8N_WEBHOOK_PING` con fallback `'/webhook/ping'`, así funciona sin agregar la var al `.env` del VPS.
  - `nest build` compila sin errores. **Pendiente**: validación end-to-end, que requiere desplegar al VPS (Redis y n8n viven en la red Docker del VPS; los hostnames `redis`/`n8n` no resuelven en local). El endpoint de prueba es `POST /internal/test-event`.

- **2026-06-29 (revisión 9 — ETAPA 1 VALIDADA + hardening de seguridad):**
  - **Validación end-to-end OK** en el VPS. `curl -X POST .../internal/test-event -H "X-Internal-Token: $TOKEN"` → `201 {"emitted":true,"eventId":"80f33f28...","traceId":"57cf5afb..."}`. Log: `[N8nDispatcher] Dispatched ping (80f33f28...)`. Toda la infraestructura de eventos funciona.
  - **Dos hallazgos de seguridad** (review automático de commits) resueltos en `n8n.controller.ts`: (1) el endpoint `/internal/test-event` quedaba sin auth detrás del reverse proxy público (logs muestran bots escaneando `/.env`, `/.aws/credentials`) → ahora exige `N8N_CALLBACK_TOKEN` en header `X-Internal-Token`, comparado en tiempo constante (`timingSafeEqual`). (2) Fail-open si el secreto estuviera vacío (`getOrThrow` no protege contra string vacío) → ahora rechaza token ausente o secreto < 16 chars antes de comparar. Commits `410facb` y `91694b7`.
  - **Recurrencia del problema del lockfile**: `npm install` corrido en Windows (local) regenera `package-lock.json` SIN las optionalDependencies nativas de Linux (`@emnapi/core`, `@emnapi/runtime`), rompiendo `npm ci` en el build Docker (Debian). Es la 3ra vez (revs 4, 5, 9). Mitigación aplicada: regenerar el lock en un contenedor Linux antes del build (`docker run --rm -v "$(pwd)":/app -w /app node:20-bookworm-slim npm install --package-lock-only`). **Pendiente**: reconciliar ese lock regenerado en el VPS hacia el repo (commit + push) y `git pull` en local. La cura de raíz es la migración a pnpm ([[project-pnpm-migration]]) o hacer todo cambio de deps en Linux.
  - **NODE_ENV**: el contenedor de producción corre con `Env: production` (lo setea el Dockerfile / `npm ci --omit=dev`), aunque el `.env` declare `development`. Tenerlo en cuenta para cualquier lógica condicionada por entorno.

- **2026-06-29 (revisión 10 — Etapa 2: backend de `conversation.handoff_requested` implementado):** implementado el lado backend completo del primer evento real. Cambios:
  - Nuevo `common/events/conversation.events.ts` con `ConversationHandoffRequestedEvent`.
  - Nuevo `integrations/n8n/listeners/conversation.listener.ts` (`ConversationListener`), encola a BullMQ con `jobId: eventId`; registrado en `n8n.module.ts`.
  - **Refactor de `webhook.service.ts`**: `createAutoHandoff` ya no escribe a Prisma directo — delega en `HandoffService.create(...)`. `HandoffService` inyectado en `WebhookService`; `HandoffModule` importado en `WebhookModule`. Comportamiento preservado (pausa conversación + handoff `PENDING` con `reason: CUSTOM`).
  - **Emisión única** en `HandoffService.create`: tras crear el registro emite el evento vía `EventEmitter2`. `traceId` leído de `ClsService` con guard `isActive()` (devuelve `undefined` fuera de contexto de request). `EventEmitter2`/`ClsService` ya son globales, no hizo falta tocar imports de módulo.
  - `nest build` compila limpio. **Pendiente** (manual/VPS): (1) crear workflow n8n `handoff-requested-notify-vendor` (HMAC + Telegram), (2) agregar `N8N_WEBHOOK_HANDOFF_REQUESTED=/webhook/handoff-requested` al `.env` del VPS — sin esta var `N8nConfig.resolveWebhookPath` devuelve `undefined` y el processor descarta el job, (3) desplegar y test end-to-end + test de caída de n8n. Commit del backend pendiente de tu visto bueno.

_Si modificás este documento, agregá una entrada nueva en esta sección con fecha y resumen de cambios._
