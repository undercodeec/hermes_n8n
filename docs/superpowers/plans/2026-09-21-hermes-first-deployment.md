# Hermes CRM First Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hermes CRM safe to deploy beside the private Nous Hermes Agent while leaving commercial Nous traffic disabled.

**Architecture:** PostgreSQL gains an at-most-once automatic-delivery ledger that records exact outbound content before Meta and treats any uncertain external outcome as terminally ambiguous. Nous inference moves behind a dedicated BullMQ queue with Redis-enforced global concurrency one, while a strict private transport implements the VPS contract and the existing engine selector keeps direct Gemini as the empty-allowlist default.

**Tech Stack:** NestJS 11, TypeScript 5.7, Prisma 5/PostgreSQL 16, BullMQ 5/Redis 7, Axios, Jest 30, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-21-hermes-first-deployment-design.md`

## Global Constraints

- Work only on `feat/hermes-conversation-engine`, starting from the approved design commit `9cd2a6f`.
- Keep `HERMES_CONVERSATION_ENGINE=gemini_direct` and `NOUS_HERMES_CONVERSATION_ALLOWLIST=` as the committed defaults.
- Do not enable a commercial conversation, deploy to the VPS, call real Meta, change Meta callbacks/WABA/templates, or publish port 8642.
- Use only `http://nous-hermes-api:8642/v1/chat/completions` and request `model="hermes-agent"` for Nous.
- Do not send `X-Hermes-Session-Id`, `X-Hermes-Session-Key`, local identity headers, tool calls, or provider selection fields.
- Never place a secret value in Git, Markdown, test fixtures, logs, command output, or customer text.
- Do not widen `/etc/hermes-agent-client/api-key` from `root:root 0600`; consume it through a runtime Docker secret file.
- Preserve campaign sending and `CampaignRecipient` idempotency without moving campaigns to the new automatic-delivery ledger.
- Preserve the existing Webhook -> BullMQ -> AutoReply -> ConversationEngine -> Meta flow and all deterministic CRM commercial rules.
- An ambiguous Meta outcome is terminal for automation and must never be resent automatically.
- Follow TDD for every behavior change and keep commits focused.

## File structure

### Existing files modified

- `hermes-backend/test/app.e2e-spec.ts` — repair the isolated Nest test module and teardown.
- `hermes-backend/prisma/schema.prisma` — add delivery enums, relations, and `AutomatedDelivery`.
- `hermes-backend/src/meta/meta.service.ts` — expose typed, redacted Meta send outcomes.
- `hermes-backend/src/meta/meta.service.spec.ts` — pin 429, 4xx, 5xx, timeout, missing-wamid, and success classification.
- `hermes-backend/src/meta/meta.module.ts` — export the delivery dependencies through normal Nest modules.
- `hermes-backend/src/conversations/conversations.service.ts` — reuse the shared WhatsApp window calculation without changing manual reply behavior.
- `hermes-backend/src/auto-replies/auto-reply.module.ts` — import the delivery module.
- `hermes-backend/src/auto-replies/auto-reply.service.ts` — recover prepared batches before inference and route all automatic parts through the ledger.
- `hermes-backend/src/auto-replies/auto-reply.service.spec.ts` — pin recovery, final guards, concurrency handoff, and multipart behavior.
- `hermes-backend/src/webhook/webhook.module.ts` — import the delivery module.
- `hermes-backend/src/webhook/webhook.service.ts` — route automatic system notices through the ledger.
- `hermes-backend/src/webhook/webhook.service.spec.ts` — prove system notices are reserved and n8n remains independent.
- `hermes-backend/src/handoff/handoff.service.ts` — make event publication best-effort after the durable handoff transaction.
- `hermes-backend/src/handoff/handoff.service.spec.ts` — prove an n8n/event-bus failure cannot undo or block handoff completion.
- `hermes-backend/src/conversation-engine/agent-output.validator.ts` — validate top-level error and finish reason.
- `hermes-backend/src/conversation-engine/agent-output.validator.spec.ts` — pin malformed and `finish_reason="error"` responses.
- `hermes-backend/src/conversation-engine/nous-hermes.engine.ts` — enqueue/wait for serialized inference instead of issuing HTTP inline.
- `hermes-backend/src/conversation-engine/nous-hermes.engine.spec.ts` — verify queue behavior, safe failures, no session headers, and isolation.
- `hermes-backend/src/conversation-engine/conversation-engine.module.ts` — register the Nous queue, processor, events, policy, and transport.
- `hermes-backend/src/conversation-engine/conversation-engine.service.spec.ts` — retain default/allowlist routing coverage.
- `hermes-backend/.env.example` — publish only the exact non-secret runtime contract.
- `hermes-backend/docker-compose.yml` — mount the secret and attach only `app` to the external network.
- `hermes-backend/package.json` — add an explicit integration-test command.
- `hermes-backend/docs/nous-hermes-runbook.md` — document deployment, failure, reconciliation, and rollback.
- `hermes-backend/docs/crm-baseline-agent.md` — append verified post-change evidence and remaining canary gate.

### Files created

- `hermes-backend/prisma/migrations/20260921170000_automated_delivery_ledger/migration.sql` — durable schema migration.
- `hermes-backend/src/meta/whatsapp-service-window.ts` — shared 24-hour window calculation.
- `hermes-backend/src/meta/whatsapp-service-window.spec.ts` — boundary tests for the calculation.
- `hermes-backend/src/automated-deliveries/automated-delivery.types.ts` — public preparation and outcome contracts.
- `hermes-backend/src/automated-deliveries/automated-delivery.service.ts` — preparation, atomic claim, Meta classification, persistence, and recovery.
- `hermes-backend/src/automated-deliveries/automated-delivery.service.spec.ts` — state-machine and race tests.
- `hermes-backend/src/automated-deliveries/automated-delivery.module.ts` — focused Nest module.
- `hermes-backend/src/conversation-engine/nous-hermes.constants.ts` — exact endpoint/model/queue constants.
- `hermes-backend/src/conversation-engine/nous-hermes.transport.ts` — secret-file loading, request construction, strict validation, and safe diagnostics.
- `hermes-backend/src/conversation-engine/nous-hermes.transport.spec.ts` — real contract tests with mocked network boundary only.
- `hermes-backend/src/conversation-engine/nous-hermes.processor.ts` — the single-purpose BullMQ inference worker.
- `hermes-backend/src/conversation-engine/nous-hermes.queue-events.ts` — QueueEvents host used by `waitUntilFinished`.
- `hermes-backend/src/conversation-engine/nous-hermes.queue-policy.ts` — persist global concurrency one in Redis.
- `hermes-backend/src/conversation-engine/nous-hermes.queue.spec.ts` — unit coverage for attempts/backoff/policy.
- `hermes-backend/test/jest-integration.json` — opt-in real-service Jest configuration.
- `hermes-backend/test/nous-hermes-queue.integration-spec.ts` — prove global concurrency against real Redis.
- `hermes-backend/test/automated-delivery.integration-spec.ts` — prove unique preparation and atomic claims against real PostgreSQL.

## Review Focus

- A worker dies after changing a delivery to `DISPATCHING` but before or after the Meta call: the operation becomes/stays unconfirmed and is never resent; Task 3 and Task 7 exercise this.
- A new inbound, opt-out, handoff, closed conversation, or 24-hour boundary occurs after inference: the final claim suppresses the send; Task 3 exercises every branch.
- Two application replicas process the same inbound and two replicas invoke Nous: PostgreSQL admits one delivery claim and Redis admits one inference globally; Tasks 3 and 6 exercise both mechanisms.
- Nous returns HTTP 200 with `finish_reason="error"`, top-level error, missing finish reason, privileged fields, or malformed content: no customer-visible provider detail and no Meta send; Task 5 exercises each shape.
- Meta returns explicit 429 versus timeout/5xx/missing wamid: only the explicit rejection is retryable; Task 2 and Task 3 exercise the classification and terminal state.

---

### Task 1: Restore the E2E baseline

**Files:**
- Modify: `hermes-backend/test/app.e2e-spec.ts:13-134`

**Interfaces:**
- Consumes: `ConversationsController(ConversationsService, ConversationEventsService)`.
- Produces: an isolated E2E module with `ConversationEventsService.stream(): Observable<MessageEvent>` and a teardown safe when setup fails.

- [ ] **Step 1: Re-run the existing failing E2E suite and capture the RED result**

Run:

```powershell
npm run test:e2e -- --runInBand
```

Expected: exit 1; 11 tests fail because `ConversationEventsService` is unavailable, followed by `Cannot read properties of undefined (reading 'close')`.

- [ ] **Step 2: Register the missing controller dependency and guard teardown**

Add the import and test double:

```typescript
import { of } from 'rxjs';
import { ConversationEventsService } from '../src/conversations/conversation-events.service';

const conversationEventsService = {
  stream: jest.fn(() => of({ type: 'connected', data: {} })),
};
```

Add this provider to `providers`:

```typescript
{
  provide: ConversationEventsService,
  useValue: conversationEventsService,
},
```

Replace teardown with:

```typescript
afterAll(async () => {
  if (app) await app.close();
});
```

- [ ] **Step 3: Run the E2E suite GREEN**

Run:

```powershell
npm run test:e2e -- --runInBand
```

Expected: 1 suite passed, 11 tests passed, exit 0.

- [ ] **Step 4: Commit the baseline repair**

```powershell
git add hermes-backend/test/app.e2e-spec.ts
git commit -m "test(crm): restore isolated e2e module"
```

---

### Task 2: Classify Meta send outcomes without leaking provider details

**Files:**
- Modify: `hermes-backend/src/meta/meta.service.spec.ts`
- Modify: `hermes-backend/src/meta/meta.service.ts:1-105`

**Interfaces:**
- Consumes: Axios errors and `MetaSendResponse`.
- Produces: `MetaSendError` with `outcome`, `retryable`, `status`, and `safeCode`; `sendTextMessage(to, text)` still returns `MetaSendResponse` on confirmed success.

- [ ] **Step 1: Write failing classification tests**

Add imports and a table-driven test:

```typescript
import { MetaSendError, MetaService } from './meta.service';

it.each([
  [429, 'DEFINITIVE_REJECTION', true, 'META_HTTP_429'],
  [400, 'DEFINITIVE_REJECTION', false, 'META_HTTP_400'],
  [401, 'DEFINITIVE_REJECTION', false, 'META_HTTP_401'],
  [500, 'AMBIGUOUS', false, 'META_HTTP_500'],
])(
  'classifies HTTP %i without exposing the provider body',
  async (status, outcome, retryable, safeCode) => {
    const service = createService();
    httpPost(service).mockRejectedValue({
      response: {
        status,
        data: { error: { code: 999, message: 'provider-secret-detail' } },
      },
    });

    const failure = await service
      .sendTextMessage('593991234567', 'Mensaje')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MetaSendError);
    expect(failure).toEqual(
      expect.objectContaining({ outcome, retryable, status, safeCode }),
    );
    expect((failure as Error).message).not.toContain('provider-secret-detail');
  },
);

it.each([{ code: 'ECONNABORTED' }, { code: 'ECONNRESET' }])(
  'classifies a transport failure as ambiguous',
  async (transportError) => {
    const service = createService();
    httpPost(service).mockRejectedValue(transportError);
    await expect(
      service.sendTextMessage('593991234567', 'Mensaje'),
    ).rejects.toEqual(
      expect.objectContaining({ outcome: 'AMBIGUOUS', retryable: false }),
    );
  },
);

it('classifies a successful response without wamid as ambiguous', async () => {
  const service = createService();
  httpPost(service).mockResolvedValue({ data: { messages: [] } });
  await expect(
    service.sendTextMessage('593991234567', 'Mensaje'),
  ).rejects.toEqual(expect.objectContaining({ outcome: 'AMBIGUOUS' }));
});
```

Keep `createService()` and `httpPost()` inside the spec as focused test helpers that instantiate the real `MetaService` and replace only its external Axios client.

- [ ] **Step 2: Run the Meta tests RED**

Run:

```powershell
npm test -- --runInBand meta/meta.service.spec.ts
```

Expected: fail because `MetaSendError` and the typed properties do not exist.

- [ ] **Step 3: Implement the typed error and classification**

Add:

```typescript
export type MetaSendOutcome = 'DEFINITIVE_REJECTION' | 'AMBIGUOUS';

export class MetaSendError extends ServiceUnavailableException {
  constructor(
    public readonly outcome: MetaSendOutcome,
    public readonly retryable: boolean,
    public readonly status: number | null,
    public readonly safeCode: string,
  ) {
    super('Meta no pudo confirmar el envío del mensaje');
  }
}
```

Replace `sendTextMessage` error wrapping with this exact decision table:

```typescript
catch (error) {
  const safe = this.toSafeError(error);
  const definitive = safe.status !== null && safe.status >= 400 && safe.status < 500;
  throw new MetaSendError(
    definitive ? 'DEFINITIVE_REJECTION' : 'AMBIGUOUS',
    safe.status === 429,
    safe.status,
    safe.status ? `META_HTTP_${safe.status}` : 'META_TRANSPORT_ERROR',
  );
}
```

Replace the missing-wamid exception with:

```typescript
if (!data.messages?.[0]?.id) {
  throw new MetaSendError('AMBIGUOUS', false, 200, 'META_WAMID_MISSING');
}
```

Log only `safeCode` and outcome. Keep `toSafeError` unchanged for campaign transport classification.

- [ ] **Step 4: Run focused and existing campaign tests GREEN**

Run:

```powershell
npm test -- --runInBand meta/meta.service.spec.ts campaigns/campaigns.service.spec.ts conversations/conversations.service.spec.ts
```

Expected: all selected suites pass; campaign behavior is unchanged.

- [ ] **Step 5: Commit Meta classification**

```powershell
git add hermes-backend/src/meta/meta.service.ts hermes-backend/src/meta/meta.service.spec.ts
git commit -m "fix(meta): classify ambiguous text sends"
```

---

### Task 3: Add the PostgreSQL automatic-delivery state machine

**Files:**
- Modify: `hermes-backend/prisma/schema.prisma`
- Create: `hermes-backend/prisma/migrations/20260921170000_automated_delivery_ledger/migration.sql`
- Create: `hermes-backend/src/meta/whatsapp-service-window.ts`
- Create: `hermes-backend/src/meta/whatsapp-service-window.spec.ts`
- Modify: `hermes-backend/src/conversations/conversations.service.ts:1-68`
- Create: `hermes-backend/src/automated-deliveries/automated-delivery.types.ts`
- Create: `hermes-backend/src/automated-deliveries/automated-delivery.service.ts`
- Create: `hermes-backend/src/automated-deliveries/automated-delivery.service.spec.ts`
- Create: `hermes-backend/src/automated-deliveries/automated-delivery.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `MetaService`, source inbound ID, exact content, sender, safe metadata, and `allowHandedOff`.
- Produces: `prepareBatch`, `recoverBatch`, `deliverPreparedBatch`, `recoverExpiredClaims`, and terminal `AutomatedDeliveryOutcome` values.

- [ ] **Step 1: Write the 24-hour boundary tests**

Create:

```typescript
import { whatsappReplyWindow } from './whatsapp-service-window';

describe('whatsappReplyWindow', () => {
  const receivedAt = new Date('2026-09-20T12:00:00.000Z');

  it('is open immediately before 24 hours', () => {
    expect(
      whatsappReplyWindow(receivedAt, new Date('2026-09-21T11:59:59.999Z'))
        .isOpen,
    ).toBe(true);
  });

  it('is closed at exactly 24 hours', () => {
    expect(
      whatsappReplyWindow(receivedAt, new Date('2026-09-21T12:00:00.000Z'))
        .isOpen,
    ).toBe(false);
  });

  it('is closed without an inbound timestamp', () => {
    expect(whatsappReplyWindow(null, new Date()).isOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run the window tests RED**

Run:

```powershell
npm test -- --runInBand meta/whatsapp-service-window.spec.ts
```

Expected: fail because the module does not exist.

- [ ] **Step 3: Implement and reuse the shared window function**

Create:

```typescript
export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function whatsappReplyWindow(
  lastInboundAt: Date | null,
  now = new Date(),
) {
  const closesAt = lastInboundAt
    ? new Date(lastInboundAt.getTime() + WHATSAPP_REPLY_WINDOW_MS)
    : null;
  return {
    isOpen: Boolean(closesAt && now.getTime() < closesAt.getTime()),
    lastInboundAt,
    closesAt,
  };
}
```

Make `ConversationsService.replyWindow()` delegate to this function so manual
reply semantics and API fields remain unchanged.

- [ ] **Step 4: Define the Prisma state model and SQL migration**

Add these enums and model to `schema.prisma`:

```prisma
enum AutomatedDeliveryKind {
  HERMES_REPLY
  SYSTEM_NOTICE
}

enum AutomatedDeliveryStatus {
  PREPARED
  DISPATCHING
  CONFIRMED
  REJECTED
  AMBIGUOUS
  SUPPRESSED
}

model AutomatedDelivery {
  id               String                    @id @default(uuid())
  operationKey     String                    @unique
  deliveryKind     AutomatedDeliveryKind
  partIndex        Int
  conversationId   String
  contactId        String
  sourceMessageId  String
  outboundMessageId String?                  @unique
  sender           MessageSender
  content          String
  allowHandedOff   Boolean                   @default(false)
  status           AutomatedDeliveryStatus  @default(PREPARED)
  attempts         Int                       @default(0)
  claimToken       String?
  claimExpiresAt   DateTime?
  dispatchStartedAt DateTime?
  confirmedAt      DateTime?
  ambiguousAt      DateTime?
  rejectedAt       DateTime?
  suppressedAt     DateTime?
  wamid             String?                  @unique
  reasonCode        String?
  metadata          Json?
  createdAt         DateTime                 @default(now())
  updatedAt         DateTime                 @updatedAt

  conversation    Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  contact         Contact      @relation(fields: [contactId], references: [id], onDelete: Cascade)
  sourceMessage   Message      @relation("AutomatedDeliverySource", fields: [sourceMessageId], references: [id], onDelete: Restrict)
  outboundMessage Message?     @relation("AutomatedDeliveryOutbound", fields: [outboundMessageId], references: [id], onDelete: SetNull)

  @@unique([sourceMessageId, deliveryKind, partIndex])
  @@index([status, claimExpiresAt])
  @@index([conversationId, createdAt])
  @@map("automated_deliveries")
}
```

Add these relation fields:

```prisma
// Contact
automatedDeliveries AutomatedDelivery[]

// Conversation
automatedDeliveries AutomatedDelivery[]

// Message
sourceAutomatedDeliveries AutomatedDelivery[] @relation("AutomatedDeliverySource")
outboundAutomatedDelivery AutomatedDelivery?  @relation("AutomatedDeliveryOutbound")
```

Create the migration with this SQL (Prisma may reorder equivalent indexes when
formatting, but names and constraints remain exact):

```sql
CREATE TYPE "AutomatedDeliveryKind" AS ENUM ('HERMES_REPLY', 'SYSTEM_NOTICE');
CREATE TYPE "AutomatedDeliveryStatus" AS ENUM (
  'PREPARED', 'DISPATCHING', 'CONFIRMED', 'REJECTED', 'AMBIGUOUS', 'SUPPRESSED'
);

CREATE TABLE "automated_deliveries" (
  "id" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "deliveryKind" "AutomatedDeliveryKind" NOT NULL,
  "partIndex" INTEGER NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "outboundMessageId" TEXT,
  "sender" "MessageSender" NOT NULL,
  "content" TEXT NOT NULL,
  "allowHandedOff" BOOLEAN NOT NULL DEFAULT false,
  "status" "AutomatedDeliveryStatus" NOT NULL DEFAULT 'PREPARED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimToken" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "dispatchStartedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "ambiguousAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "suppressedAt" TIMESTAMP(3),
  "wamid" TEXT,
  "reasonCode" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automated_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automated_deliveries_operationKey_key"
  ON "automated_deliveries"("operationKey");
CREATE UNIQUE INDEX "automated_deliveries_outboundMessageId_key"
  ON "automated_deliveries"("outboundMessageId");
CREATE UNIQUE INDEX "automated_deliveries_wamid_key"
  ON "automated_deliveries"("wamid");
CREATE UNIQUE INDEX "automated_deliveries_sourceMessageId_deliveryKind_partIndex_key"
  ON "automated_deliveries"("sourceMessageId", "deliveryKind", "partIndex");
CREATE INDEX "automated_deliveries_status_claimExpiresAt_idx"
  ON "automated_deliveries"("status", "claimExpiresAt");
CREATE INDEX "automated_deliveries_conversationId_createdAt_idx"
  ON "automated_deliveries"("conversationId", "createdAt");

ALTER TABLE "automated_deliveries"
  ADD CONSTRAINT "automated_deliveries_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automated_deliveries"
  ADD CONSTRAINT "automated_deliveries_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "contacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automated_deliveries"
  ADD CONSTRAINT "automated_deliveries_sourceMessageId_fkey"
  FOREIGN KEY ("sourceMessageId") REFERENCES "messages"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automated_deliveries"
  ADD CONSTRAINT "automated_deliveries_outboundMessageId_fkey"
  FOREIGN KEY ("outboundMessageId") REFERENCES "messages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 5: Validate the schema before service work**

Run:

```powershell
npx prisma format
npx prisma validate
npx prisma generate
```

Expected: all commands exit 0 and the generated client contains
`AutomatedDeliveryStatus` and `automatedDelivery`.

- [ ] **Step 6: Write failing state-machine tests**

Create a deterministic in-memory Prisma harness that implements the same
`create`, `findMany`, `findUnique`, `updateMany`, `update`, and `$transaction`
calls used by the service. The tests must exercise the real service and only
replace PostgreSQL and Meta boundaries.

Add these tests with literal outcomes:

```typescript
it('prepares every multipart operation before the first Meta call', async () => {
  const pendingAtFirstSend: number[] = [];
  meta.sendTextMessage.mockImplementation(async () => {
    pendingAtFirstSend.push(store.rows.length);
    return confirmedMetaResponse('wamid.1');
  });
  await service.prepareBatch(batch('uno', 'dos'));
  await service.deliverPreparedBatch('inbound-1');
  expect(pendingAtFirstSend[0]).toBe(2);
});

it('lets only one concurrent worker claim an operation', async () => {
  await service.prepareBatch(batch('respuesta'));
  await Promise.all([
    service.deliverPreparedBatch('inbound-1'),
    service.deliverPreparedBatch('inbound-1'),
  ]);
  expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
});

it('retries safely when failure is provably before DISPATCHING', async () => {
  store.failNextClaimTransaction = true;
  await service.prepareBatch(batch('respuesta'));
  await expect(service.deliverPreparedBatch('inbound-1')).rejects.toThrow(
    'claim transaction failed',
  );
  expect(store.rows[0].status).toBe('PREPARED');
  expect(meta.sendTextMessage).not.toHaveBeenCalled();
  await service.deliverPreparedBatch('inbound-1');
  expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
});

it('treats an unexpected throw after claim as ambiguous', async () => {
  meta.sendTextMessage.mockRejectedValueOnce(new Error('process interrupted'));
  await service.prepareBatch(batch('respuesta'));
  await service.deliverPreparedBatch('inbound-1');
  await service.deliverPreparedBatch('inbound-1');
  expect(store.rows[0].status).toBe('AMBIGUOUS');
  expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
});

it.each([
  ['NEWER_INBOUND'],
  ['CONTACT_OPTED_OUT'],
  ['HANDOFF_ACTIVE'],
  ['CONVERSATION_NOT_ACTIVE'],
  ['WHATSAPP_TEMPLATE_REQUIRED'],
])('suppresses at the final boundary: %s', async (reasonCode) => {
  arrangeEligibilityFailure(reasonCode);
  await service.prepareBatch(batch('respuesta'));
  const result = await service.deliverPreparedBatch('inbound-1');
  expect(result).toEqual(expect.objectContaining({ terminal: true, reasonCode }));
  expect(meta.sendTextMessage).not.toHaveBeenCalled();
});

it.each([
  [new MetaSendError('AMBIGUOUS', false, null, 'META_TRANSPORT_ERROR')],
  [new MetaSendError('AMBIGUOUS', false, 500, '500')],
  [new MetaSendError('AMBIGUOUS', false, 200, 'META_WAMID_MISSING')],
])('marks an uncertain result ambiguous and never resends it', async (error) => {
  meta.sendTextMessage.mockRejectedValueOnce(error);
  await service.prepareBatch(batch('respuesta'));
  await service.deliverPreparedBatch('inbound-1');
  await service.deliverPreparedBatch('inbound-1');
  expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  expect(store.rows[0].status).toBe('AMBIGUOUS');
});

it('returns an explicit 429 to PREPARED for a bounded queue retry', async () => {
  meta.sendTextMessage.mockRejectedValueOnce(
    new MetaSendError('DEFINITIVE_REJECTION', true, 429, '429'),
  );
  await service.prepareBatch(batch('respuesta'));
  await expect(service.deliverPreparedBatch('inbound-1')).rejects.toMatchObject({
    retryable: true,
  });
  expect(store.rows[0].status).toBe('PREPARED');
});

it('marks an expired DISPATCHING claim ambiguous on restart', async () => {
  store.rows.push(expiredDispatchingRow());
  await service.onApplicationBootstrap();
  expect(store.rows[0].status).toBe('AMBIGUOUS');
  expect(meta.sendTextMessage).not.toHaveBeenCalled();
});

it('resumes a PREPARED batch after worker restart without regenerating it', async () => {
  store.rows.push(preparedRow({ content: 'contenido original' }));
  const result = await service.recoverBatch('inbound-1');
  expect(result).toEqual(expect.objectContaining({ handled: true, confirmed: 1 }));
  expect(meta.sendTextMessage).toHaveBeenCalledWith(
    '593991234567',
    'contenido original',
  );
});

it('marks persistence failure after a confirmed Meta call ambiguous', async () => {
  meta.sendTextMessage.mockResolvedValue(confirmedMetaResponse('wamid.1'));
  store.failConfirmationTransaction = true;
  await service.prepareBatch(batch('respuesta'));
  await service.deliverPreparedBatch('inbound-1');
  expect(store.rows[0].status).toBe('AMBIGUOUS');
});
```

- [ ] **Step 7: Run the delivery tests RED**

Run:

```powershell
npm test -- --runInBand automated-deliveries/automated-delivery.service.spec.ts
```

Expected: fail because the delivery service and public types do not exist.

- [ ] **Step 8: Implement the public delivery contracts**

Create:

```typescript
export type AutomatedDeliveryPart = {
  partIndex: number;
  content: string;
  metadata?: Record<string, unknown>;
};

export type PrepareAutomatedDeliveryBatch = {
  deliveryKind: 'HERMES_REPLY' | 'SYSTEM_NOTICE';
  conversationId: string;
  contactId: string;
  sourceMessageId: string;
  sender: 'HERMES' | 'SYSTEM';
  allowHandedOff: boolean;
  parts: AutomatedDeliveryPart[];
};

export type AutomatedDeliveryBatchResult = {
  handled: boolean;
  confirmed: number;
  terminal: boolean;
  reasonCode?: string;
};
```

- [ ] **Step 9: Implement preparation, recovery, eligibility, claim, and confirmation**

Implement `AutomatedDeliveryService implements OnApplicationBootstrap,
OnModuleDestroy` with
these exact methods:

```typescript
prepareBatch(input: PrepareAutomatedDeliveryBatch): Promise<void>;
recoverBatch(sourceMessageId: string): Promise<AutomatedDeliveryBatchResult | null>;
deliverPreparedBatch(sourceMessageId: string): Promise<AutomatedDeliveryBatchResult>;
recoverExpiredClaims(now?: Date): Promise<number>;
onApplicationBootstrap(): Promise<void>;
onModuleDestroy(): void;
```

`recoverBatch` first loads rows by `sourceMessageId`. It returns `null` when no
batch exists; otherwise it calls `deliverPreparedBatch` for stored `PREPARED`
parts and returns that result with `handled:true`. It never overwrites stored
content and never invokes inference.

Use a 60-second claim lease, which is longer than the Meta client's 30-second
HTTP timeout. `onApplicationBootstrap` performs one recovery pass and starts an
unref'ed 15-second interval that calls `recoverExpiredClaims`; `onModuleDestroy`
clears that interval. The recovery update must match both `DISPATCHING` and
`claimExpiresAt < now`, so a newly started replica cannot invalidate another
replica's live claim.

Preparation uses `upsert` on `operationKey` and never overwrites content once
created. Before each part, run a Prisma transaction that:

```typescript
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operation.operationKey}))`;
```

Then reload the operation, conversation/contact, open handoff, and most recent
inbound. Evaluate the guards, or claim with:

```typescript
const claim = await tx.automatedDelivery.updateMany({
  where: { id: operation.id, status: 'PREPARED', claimToken: null },
  data: {
    status: 'DISPATCHING',
    claimToken,
    claimExpiresAt,
    dispatchStartedAt: now,
    attempts: { increment: 1 },
  },
});
```

Use the provider timestamp from `rawPayload.timestamp` when valid, otherwise
`createdAt`, and `whatsappReplyWindow` for the boundary. Treat
`MarketingConsentStatus.OPTED_OUT` as `CONTACT_OPTED_OUT`. A handoff-transition
notice may pass only when `allowHandedOff` is true; a normal Hermes reply may
not.

After a confirmed Meta response, one transaction creates the outbound `Message`
and conditionally updates the delivery where `claimToken` still matches:

```typescript
const message = await tx.message.create({ data: messageData });
await tx.automatedDelivery.update({
  where: { id: operation.id },
  data: {
    status: 'CONFIRMED',
    outboundMessageId: message.id,
    wamid,
    confirmedAt: now,
    claimToken: null,
    claimExpiresAt: null,
    reasonCode: null,
  },
});
```

Map `MetaSendError` exactly as specified in Task 2. A concurrent observation of
an unexpired `DISPATCHING` row returns `{handled:true, confirmed:0,
terminal:false, reasonCode:'DELIVERY_IN_PROGRESS'}` and never changes the row.

- [ ] **Step 10: Register the focused module and run GREEN tests**

Create:

```typescript
@Module({
  imports: [MetaModule],
  providers: [AutomatedDeliveryService],
  exports: [AutomatedDeliveryService],
})
export class AutomatedDeliveryModule {}
```

Run:

```powershell
npm test -- --runInBand meta/whatsapp-service-window.spec.ts automated-deliveries/automated-delivery.service.spec.ts conversations/conversations.service.spec.ts
npx prisma validate
```

Expected: all selected suites pass and Prisma validation exits 0.

- [ ] **Step 11: Commit the durable ledger**

```powershell
git add hermes-backend/prisma hermes-backend/src/meta/whatsapp-service-window.ts hermes-backend/src/meta/whatsapp-service-window.spec.ts hermes-backend/src/conversations/conversations.service.ts hermes-backend/src/automated-deliveries
git commit -m "feat(meta): add durable automatic delivery ledger"
```

---

### Task 4: Route automatic replies and webhook notices through the ledger

**Files:**
- Modify: `hermes-backend/src/auto-replies/auto-reply.module.ts`
- Modify: `hermes-backend/src/auto-replies/auto-reply.service.ts`
- Modify: `hermes-backend/src/auto-replies/auto-reply.service.spec.ts`
- Modify: `hermes-backend/src/webhook/webhook.module.ts`
- Modify: `hermes-backend/src/webhook/webhook.service.ts`
- Modify: `hermes-backend/src/webhook/webhook.service.spec.ts`
- Modify: `hermes-backend/src/handoff/handoff.service.ts`
- Modify: `hermes-backend/src/handoff/handoff.service.spec.ts`

**Interfaces:**
- Consumes: Task 3 `AutomatedDeliveryService` methods.
- Produces: every `HERMES`/`SYSTEM` automatic text send is prepared before Meta and is recovery-first on BullMQ retry.

- [ ] **Step 1: Write failing AutoReply recovery and multipart tests**

Extend the existing harness with a real-shaped delivery double and add:

```typescript
it('resumes a prepared batch before quota or inference', async () => {
  deliveries.recoverBatch.mockResolvedValue({
    handled: true,
    confirmed: 1,
    terminal: true,
  });
  await service.process(jobData);
  expect(conversationGuard.consumeAiQuota).not.toHaveBeenCalled();
  expect(conversationEngine.respond).not.toHaveBeenCalled();
  expect(meta.sendTextMessage).not.toHaveBeenCalled();
});

it('prepares all generated parts and delegates delivery once', async () => {
  await service.process(jobDataForLongReply);
  expect(deliveries.prepareBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      deliveryKind: 'HERMES_REPLY',
      sourceMessageId: 'inbound-long',
      sender: 'HERMES',
      parts: [
        expect.objectContaining({ partIndex: 0 }),
        expect.objectContaining({ partIndex: 1 }),
      ],
    }),
  );
  expect(deliveries.deliverPreparedBatch).toHaveBeenCalledWith('inbound-long');
  expect(meta.sendTextMessage).not.toHaveBeenCalled();
});

it('does not persist lead state when the delivery is suppressed', async () => {
  deliveries.deliverPreparedBatch.mockResolvedValue({
    handled: true,
    confirmed: 0,
    terminal: true,
    reasonCode: 'NEWER_INBOUND',
  });
  await service.process(jobData);
  expect(leads.recordCommercialProfileFromConversation).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing webhook system-notice tests**

Inject a delivery double into `WebhookService` and change the audio test to
assert:

```typescript
expect(deliveries.prepareBatch).toHaveBeenCalledWith({
  deliveryKind: 'SYSTEM_NOTICE',
  conversationId: 'conversation-1',
  contactId: 'contact-1',
  sourceMessageId: 'inbound-1',
  sender: 'SYSTEM',
  allowHandedOff: false,
  parts: [
    expect.objectContaining({
      partIndex: 0,
      metadata: { action: 'AUDIO_TRANSCRIPTION_UNAVAILABLE' },
    }),
  ],
});
expect(deliveries.deliverPreparedBatch).toHaveBeenCalledWith('inbound-1');
expect(meta.sendTextMessage).not.toHaveBeenCalled();
```

Add a support-handoff case with `allowHandedOff: true`.

- [ ] **Step 3: Write the failing n8n/event isolation test**

In `handoff.service.spec.ts`, use the existing valid handoff fixture and make the
event emitter throw synchronously, which is the strongest way an in-process
listener could block the caller:

```typescript
events.emit.mockImplementation(() => {
  throw new Error('n8n queue unavailable');
});
await expect(service.create(validHandoffInput)).resolves.toEqual(
  expect.objectContaining({ id: 'handoff-1' }),
);
expect(prisma.humanHandoff.create).toHaveBeenCalledTimes(1);
```

Expected production behavior is to log a safe warning after the durable
handoff transaction and continue. The existing async `@OnEvent` listener and
separate n8n BullMQ processor continue to own network retries.

- [ ] **Step 4: Run focused tests RED**

Run:

```powershell
npm test -- --runInBand auto-replies/auto-reply.service.spec.ts webhook/webhook.service.spec.ts handoff/handoff.service.spec.ts
```

Expected: fail because both services still call `MetaService` directly and lack
the new constructor dependency.

- [ ] **Step 5: Integrate the recovery-first path into AutoReplyService**

After validating/loading the source inbound but before quota, policy side
effects, or inference, add:

```typescript
const recovered = await this.deliveries.recoverBatch(inbound.id);
if (recovered?.handled) {
  this.logSkip(data, 'EXISTING_DELIVERY_BATCH', {
    confirmed: recovered.confirmed,
    terminal: recovered.terminal,
    reasonCode: recovered.reasonCode,
  });
  return;
}
```

Replace both `sendAndPersist` and the generated multipart Meta loop with a call
that prepares all exact parts, then calls `deliverPreparedBatch`. Continue lead,
conversation-state, and qualification persistence only when at least one part
was confirmed. Keep typing indicators best-effort and outside the durable send.

- [ ] **Step 6: Integrate system notices into WebhookService**

Pass `inboundMessage.id` into every `sendSystemMessage` call. Replace its direct
Meta/Prisma code with:

```typescript
await this.deliveries.prepareBatch({
  deliveryKind: 'SYSTEM_NOTICE',
  conversationId,
  contactId,
  sourceMessageId,
  sender: 'SYSTEM',
  allowHandedOff,
  parts: [{ partIndex: 0, content, metadata: { action } }],
});
await this.deliveries.deliverPreparedBatch(sourceMessageId);
```

Use `allowHandedOff=true` only for the support/human-transition notices that are
prepared after a handoff is created. Guard and audio notices remain false.

- [ ] **Step 7: Make handoff event publication best-effort**

Wrap only the post-transaction `this.events.emit(...)` call in
`HandoffService.create`:

```typescript
// Add Logger to the @nestjs/common import and this class field.
private readonly logger = new Logger(HandoffService.name);

try {
  this.events.emit(event.name, event);
} catch (error) {
  this.logger.warn(
    `No se pudo publicar el evento de handoff ${handoff.id}: ${
      error instanceof Error ? error.message : 'event publication failed'
    }`,
  );
}
```

Do not move the database transaction into this catch and do not call n8n
directly.

- [ ] **Step 8: Import the module and run focused GREEN tests**

Import `AutomatedDeliveryModule` into `AutoReplyModule` and `WebhookModule`.
Run:

```powershell
npm test -- --runInBand auto-replies/auto-reply.service.spec.ts auto-replies/auto-reply.processor.spec.ts webhook/webhook.service.spec.ts handoff/handoff.service.spec.ts campaigns/campaigns.service.spec.ts
```

Expected: all selected suites pass; no AutoReply/Webhook test expects a direct
Meta text call, and campaign tests remain unchanged.

- [ ] **Step 9: Commit automatic-flow integration**

```powershell
git add hermes-backend/src/auto-replies hermes-backend/src/webhook hermes-backend/src/handoff
git commit -m "fix(whatsapp): reserve automatic sends before Meta"
```

---

### Task 5: Implement the exact private Nous transport contract

**Files:**
- Create: `hermes-backend/src/conversation-engine/nous-hermes.constants.ts`
- Create: `hermes-backend/src/conversation-engine/nous-hermes.transport.ts`
- Create: `hermes-backend/src/conversation-engine/nous-hermes.transport.spec.ts`
- Modify: `hermes-backend/src/conversation-engine/agent-output.validator.ts`
- Modify: `hermes-backend/src/conversation-engine/agent-output.validator.spec.ts`
- Modify: `hermes-backend/src/conversation-engine/nous-hermes.engine.ts`
- Modify: `hermes-backend/src/conversation-engine/nous-hermes.engine.spec.ts`
- Modify: `hermes-backend/src/conversation-engine/conversation-engine.module.ts`

**Interfaces:**
- Consumes: `ConversationTurnInput`, exact private configuration, and the mounted secret file.
- Produces: `NousHermesTransport.execute(input): Promise<ConversationTurnResult>`; throws `NousHermesRateLimitError` only for HTTP 429.

- [ ] **Step 1: Add failing validator cases**

Extend the malformed-output table with:

```typescript
{ error: { message: 'provider failed' }, choices: [{ finish_reason: 'stop', message: { content: 'texto' } }] },
{ choices: [{ finish_reason: 'error', message: { content: 'provider detail' } }] },
{ choices: [{ message: { content: 'texto' } }] },
{ choices: [{ finish_reason: '', message: { content: 'texto' } }] },
```

Update the valid fixture to include `finish_reason: 'stop'`.

- [ ] **Step 2: Run validator tests RED**

Run:

```powershell
npm test -- --runInBand conversation-engine/agent-output.validator.spec.ts
```

Expected: at least the top-level error, missing finish reason, and
`finish_reason="error"` cases are accepted incorrectly.

- [ ] **Step 3: Enforce top-level error and finish reason**

Extend `ChatCompletionPayload` with `error?: unknown` and each choice with
`finish_reason?: unknown`. Before content validation add:

```typescript
if (completion.error !== undefined) {
  throw new InvalidAgentOutputError('Agent response contains a top-level error');
}
const choice = completion.choices?.[0];
if (
  !choice ||
  typeof choice.finish_reason !== 'string' ||
  !choice.finish_reason.trim() ||
  choice.finish_reason.trim().toLowerCase() === 'error'
) {
  throw new InvalidAgentOutputError('Agent response has an invalid finish reason');
}
const message = choice.message;
```

- [ ] **Step 4: Write failing exact-transport tests**

Create constants:

```typescript
export const NOUS_HERMES_ENDPOINT =
  'http://nous-hermes-api:8642/v1/chat/completions';
export const NOUS_HERMES_MODEL = 'hermes-agent';
export const NOUS_HERMES_INFERENCE_QUEUE = 'nous-hermes-inference';
```

Keep file I/O behind this provider in `nous-hermes.transport.ts`:

```typescript
@Injectable()
export class NousHermesSecretReader {
  read(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }
}
```

Inject `NousHermesSecretReader` into the transport. Test with a mocked reader
and mocked Axios boundary:

```typescript
it('uses only the exact alias, stateless messages, and minimal headers', async () => {
  post.mockResolvedValue({
    data: {
      model: 'hermes-agent',
      choices: [{ finish_reason: 'stop', message: { content: 'Respuesta.' } }],
    },
  });
  const result = await transport.execute(baseInput());
  expect(post).toHaveBeenCalledWith(
    NOUS_HERMES_ENDPOINT,
    expect.objectContaining({ model: 'hermes-agent', stream: false }),
    expect.objectContaining({
      headers: {
        Authorization: 'Bearer file-secret',
        'Content-Type': 'application/json',
      },
      maxRedirects: 0,
    }),
  );
  expect(JSON.stringify(post.mock.calls[0][2])).not.toMatch(
    /X-Hermes-Session|X-Hermes-Conversation|X-Hermes-Trace/i,
  );
  expect(result.providerModel).toBe('hermes-agent');
});

it.each([
  'https://nous-hermes-api:8642/v1/chat/completions',
  'http://public.example/v1/chat/completions',
  'http://nous-hermes-api:8642/v1/chat/completions?x=1',
  'http://user@nous-hermes-api:8642/v1/chat/completions',
])('rejects any destination outside the exact private contract: %s', async (url) => {
  const result = await configuredTransport({
    NOUS_HERMES_CHAT_COMPLETIONS_URL: url,
  }).execute(baseInput());
  expect(post).not.toHaveBeenCalled();
  expect(result.diagnostic?.code).toBe('NOUS_HERMES_CONFIGURATION_INVALID');
});

it('reads and trims the mounted secret without logging it', async () => {
  secretReader.read.mockResolvedValue('file-secret\n');
  await transport.execute(baseInput());
  expect(secretReader.read).toHaveBeenCalledWith(
    '/run/secrets/nous_hermes_api_key',
  );
});

it('throws a typed rate limit for queue retry and maps other failures safely', async () => {
  post.mockRejectedValueOnce({ response: { status: 429 } });
  await expect(transport.execute(baseInput())).rejects.toBeInstanceOf(
    NousHermesRateLimitError,
  );
  post.mockRejectedValueOnce({ response: { status: 500 } });
  await expect(transport.execute(baseInput())).resolves.toEqual(
    expect.objectContaining({
      diagnostic: expect.objectContaining({ code: 'NOUS_HERMES_UNAVAILABLE' }),
    }),
  );
});
```

Add this table and the isolation assertion:

```typescript
it.each([
  [401, 'NOUS_HERMES_AUTH_REJECTED'],
  [403, 'NOUS_HERMES_AUTH_REJECTED'],
  [500, 'NOUS_HERMES_UNAVAILABLE'],
])('maps HTTP %i to %s without provider detail', async (status, code) => {
  post.mockRejectedValue({
    response: { status, data: { error: { message: 'private-provider-detail' } } },
  });
  const result = await transport.execute(baseInput());
  expect(result.diagnostic?.code).toBe(code);
  expect(result.replyText).not.toContain('private-provider-detail');
});

it.each([
  { choices: [] },
  { error: { message: 'failed' }, choices: [] },
  { choices: [{ finish_reason: 'error', message: { content: 'failed' } }] },
  { choices: [{ finish_reason: 'stop', message: { content: 'x', tool_calls: [{}] } }] },
  { choices: [{ finish_reason: 'stop', message: { content: 'x', reasoning_content: 'hidden' } }] },
])('rejects malformed or privileged completion %#', async (data) => {
  post.mockResolvedValue({ data });
  const result = await transport.execute(baseInput());
  expect(result.diagnostic?.code).toBe('NOUS_HERMES_INVALID_RESPONSE');
});

it('maps timeout and an absent secret file safely', async () => {
  post.mockRejectedValueOnce({ code: 'ECONNABORTED' });
  expect((await transport.execute(baseInput())).diagnostic?.code).toBe(
    'NOUS_HERMES_TIMEOUT',
  );
  secretReader.read.mockRejectedValueOnce(new Error('ENOENT /private/path'));
  const missing = await transport.execute(baseInput());
  expect(missing.diagnostic?.code).toBe('NOUS_HERMES_CONFIGURATION_INVALID');
  expect(missing.replyText).not.toContain('/private/path');
});

it('keeps two request histories disjoint and distrusts a mismatched model', async () => {
  post
    .mockResolvedValueOnce({
      data: {
        model: 'different-model',
        choices: [{ finish_reason: 'stop', message: { content: 'A' } }],
      },
    })
    .mockResolvedValueOnce({
      data: {
        model: 'hermes-agent',
        choices: [{ finish_reason: 'stop', message: { content: 'B' } }],
      },
    });
  const first = await transport.execute(inputFor('conversation-a', 'canary-a'));
  const second = await transport.execute(inputFor('conversation-b', 'canary-b'));
  expect(first.providerModel).toBe('unknown');
  expect(JSON.stringify(post.mock.calls[0][1])).toContain('canary-a');
  expect(JSON.stringify(post.mock.calls[0][1])).not.toContain('canary-b');
  expect(JSON.stringify(post.mock.calls[1][1])).toContain('canary-b');
  expect(JSON.stringify(post.mock.calls[1][1])).not.toContain('canary-a');
  expect(second.providerModel).toBe('hermes-agent');
});
```

- [ ] **Step 5: Run transport tests RED**

Run:

```powershell
npm test -- --runInBand conversation-engine/agent-output.validator.spec.ts conversation-engine/nous-hermes.transport.spec.ts
```

Expected: transport module is missing and validator cases fail.

- [ ] **Step 6: Extract the transport and remove obsolete identity configuration**

Move request-message construction, commercial-profile minimization, Axios call,
secret checking, and diagnostic mapping from `NousHermesEngine` to
`NousHermesTransport`.

The configuration method must:

```typescript
const configuredUrl = this.config.get<string>(
  'NOUS_HERMES_CHAT_COMPLETIONS_URL',
  NOUS_HERMES_ENDPOINT,
).trim();
if (configuredUrl !== NOUS_HERMES_ENDPOINT) {
  throw new ConversationEngineConfigurationError(
    'NOUS_HERMES_CHAT_COMPLETIONS_URL must match the private contract',
  );
}
const secretPath = this.config.get<string>(
  'NOUS_HERMES_API_KEY_FILE',
  '/run/secrets/nous_hermes_api_key',
).trim();
const apiKey = (await this.secretReader.read(secretPath)).trim();
if (!apiKey) throw new ConversationEngineConfigurationError('Nous secret file is empty');
```

Send `NOUS_HERMES_MODEL`, `stream:false`, approved messages, minimal headers,
`maxRedirects:0`, timeout, and byte limits. Never send or calculate an identity
header. Keep `proposedActions:[{type:'none'}]`.

- [ ] **Step 7: Keep the engine temporarily delegating directly and run GREEN**

Make `NousHermesEngine.respond()` call `transport.execute(input)` for this task;
Task 6 replaces that direct delegation with the queue. Register the transport in
`ConversationEngineModule` together with `NousHermesSecretReader`.

Run:

```powershell
npm test -- --runInBand conversation-engine/agent-output.validator.spec.ts conversation-engine/nous-hermes.transport.spec.ts conversation-engine/nous-hermes.engine.spec.ts conversation-engine/conversation-engine.service.spec.ts
```

Expected: all selected suites pass, including explicit HTTP 200 +
`finish_reason="error"` rejection.

- [ ] **Step 8: Commit the real private contract**

```powershell
git add hermes-backend/src/conversation-engine
git commit -m "feat(hermes): implement private agent contract v1"
```

---

### Task 6: Serialize Nous inference globally with BullMQ

**Files:**
- Create: `hermes-backend/src/conversation-engine/nous-hermes.processor.ts`
- Create: `hermes-backend/src/conversation-engine/nous-hermes.queue-events.ts`
- Create: `hermes-backend/src/conversation-engine/nous-hermes.queue-policy.ts`
- Create: `hermes-backend/src/conversation-engine/nous-hermes.queue.spec.ts`
- Modify: `hermes-backend/src/conversation-engine/nous-hermes.engine.ts`
- Modify: `hermes-backend/src/conversation-engine/nous-hermes.engine.spec.ts`
- Modify: `hermes-backend/src/conversation-engine/conversation-engine.module.ts`

**Interfaces:**
- Consumes: `NousHermesTransport.execute`, BullMQ Redis connection, and `ConversationTurnInput`.
- Produces: one globally active Nous job, bounded 429 attempts/backoff, and a safe `ConversationTurnResult` returned to AutoReply.

- [ ] **Step 1: Write failing queue-policy and processor tests**

Add:

```typescript
it('persists global concurrency one at application bootstrap', async () => {
  const queue = { setGlobalConcurrency: jest.fn().mockResolvedValue(1) };
  await new NousHermesQueuePolicy(queue as never).onApplicationBootstrap();
  expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
});

it('lets BullMQ retry only a typed agent 429', async () => {
  transport.execute.mockRejectedValue(new NousHermesRateLimitError());
  await expect(processor.process(job(baseInput()))).rejects.toBeInstanceOf(
    NousHermesRateLimitError,
  );
  transport.execute.mockResolvedValue(safeTimeoutResult());
  await expect(processor.process(job(baseInput()))).resolves.toEqual(
    safeTimeoutResult(),
  );
});
```

Change the engine test to assert queue options:

```typescript
expect(queue.add).toHaveBeenCalledWith(
  'infer',
  baseInput(),
  expect.objectContaining({
    jobId: 'nous-inbound-1',
    attempts: 3,
    backoff: { type: 'exponential', delay: 1500 },
    removeOnComplete: true,
  }),
);
expect(job.waitUntilFinished).toHaveBeenCalledWith(
  queueEvents.queueEvents,
  120000,
);
```

Add tests mapping final job failure to `NOUS_HERMES_RATE_LIMITED`, queue-add
failure to `NOUS_HERMES_QUEUE_UNAVAILABLE`, and ensuring the safe customer text
contains neither Redis nor provider details.

- [ ] **Step 2: Run queue tests RED**

Run:

```powershell
npm test -- --runInBand conversation-engine/nous-hermes.queue.spec.ts conversation-engine/nous-hermes.engine.spec.ts
```

Expected: queue policy, processor, and event host do not exist; engine still
delegates directly.

- [ ] **Step 3: Implement processor, QueueEvents host, and global policy**

Create:

```typescript
@Processor(NOUS_HERMES_INFERENCE_QUEUE, { concurrency: 1 })
export class NousHermesProcessor extends WorkerHost {
  constructor(private readonly transport: NousHermesTransport) {
    super();
  }

  process(job: Job<ConversationTurnInput>): Promise<ConversationTurnResult> {
    return this.transport.execute(job.data);
  }
}

@QueueEventsListener(NOUS_HERMES_INFERENCE_QUEUE)
export class NousHermesQueueEvents extends QueueEventsHost {}

@Injectable()
export class NousHermesQueuePolicy implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(NOUS_HERMES_INFERENCE_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.setGlobalConcurrency(1);
  }
}
```

- [ ] **Step 4: Enqueue and wait from NousHermesEngine**

Inject the queue, queue-events host, and config. Preserve the handoff-active
short circuit before Redis. Add the job with configuration parsed as positive
integers and use these defaults:

```typescript
const attempts = this.positiveInteger('NOUS_HERMES_MAX_ATTEMPTS', 3);
const delay = this.positiveInteger('NOUS_HERMES_BACKOFF_MS', 1500);
const waitTimeout = this.positiveInteger(
  'NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS',
  120000,
);
const job = await this.queue.add('infer', input, {
  jobId: `nous-${input.inboundMessageId}`,
  attempts,
  backoff: { type: 'exponential', delay },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600, count: 1000 },
});
return await job.waitUntilFinished(this.queueEvents.queueEvents, waitTimeout);
```

Only transport 429 throws from the processor, so a terminal job failure maps to
the rate-limit diagnostic. Catch queue connection/add/wait infrastructure errors
separately and map them to `NOUS_HERMES_QUEUE_UNAVAILABLE` without exposing the
error message to the customer.

- [ ] **Step 5: Register the queue and providers**

Add to `ConversationEngineModule`:

```typescript
BullModule.registerQueue({ name: NOUS_HERMES_INFERENCE_QUEUE }),
```

Register `NousHermesProcessor`, `NousHermesQueueEvents`,
`NousHermesQueuePolicy`, and `NousHermesTransport` as providers.

- [ ] **Step 6: Run queue and routing tests GREEN**

Run:

```powershell
npm test -- --runInBand conversation-engine/nous-hermes.queue.spec.ts conversation-engine/nous-hermes.engine.spec.ts conversation-engine/conversation-engine.service.spec.ts auto-replies/auto-reply.service.spec.ts
```

Expected: all selected suites pass; direct Gemini tests never require Redis.

- [ ] **Step 7: Commit distributed inference**

```powershell
git add hermes-backend/src/conversation-engine
git commit -m "feat(hermes): serialize agent inference in Redis"
```

---

### Task 7: Add real Redis/PostgreSQL integration verification

**Files:**
- Modify: `hermes-backend/package.json`
- Create: `hermes-backend/test/jest-integration.json`
- Create: `hermes-backend/test/nous-hermes-queue.integration-spec.ts`
- Create: `hermes-backend/test/automated-delivery.integration-spec.ts`

**Interfaces:**
- Consumes: `REDIS_INTEGRATION_URL` and `DATABASE_INTEGRATION_URL` pointing to disposable local services.
- Produces: evidence that BullMQ global concurrency and PostgreSQL claim uniqueness work outside mocks.

- [ ] **Step 1: Add an explicit integration Jest target**

Add to `package.json`:

```json
"test:integration": "jest --config ./test/jest-integration.json --runInBand"
```

Create `test/jest-integration.json`:

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testRegex": ".*\\.integration-spec\\.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  "testEnvironment": "node",
  "testTimeout": 30000
}
```

- [ ] **Step 2: Write the real Redis concurrency test**

Create the test with a unique queue and two workers on the same Redis:

```typescript
import { randomUUID } from 'node:crypto';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';

describe('Nous BullMQ global concurrency (integration)', () => {
  const redisUrl = process.env.REDIS_INTEGRATION_URL;
  const queueName = `nous-concurrency-${randomUUID()}`;
  const connection = (() => {
    if (!redisUrl) throw new Error('REDIS_INTEGRATION_URL is required');
    const url = new URL(redisUrl);
    return {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
      maxRetriesPerRequest: null,
    };
  })();
  const queue = new Queue(queueName, { connection });
  const events = new QueueEvents(queueName, { connection });
  const workers: Worker[] = [];

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('runs only one job across two workers', async () => {
    let active = 0;
    let maximumActive = 0;
    const processor = async (_job: Job) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'ok';
      } finally {
        active -= 1;
      }
    };
    workers.push(
      new Worker(queueName, processor, { connection, concurrency: 2 }),
      new Worker(queueName, processor, { connection, concurrency: 2 }),
    );
    await events.waitUntilReady();
    await queue.setGlobalConcurrency(1);
    const jobs = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        queue.add('infer', { index }, { removeOnComplete: false }),
      ),
    );
    await Promise.all(jobs.map((job) => job.waitUntilFinished(events, 10000)));
    expect(maximumActive).toBe(1);
    expect(await queue.getGlobalConcurrency()).toBe(1);
  });
});
```

The test throws a clear setup error when `REDIS_INTEGRATION_URL` is absent
rather than silently skipping the integration gate.

- [ ] **Step 3: Write the real PostgreSQL claim test**

Create the PostgreSQL test:

```typescript
import { randomUUID } from 'node:crypto';
import {
  AutomatedDeliveryKind,
  AutomatedDeliveryStatus,
  MessageDirection,
  MessageSender,
  MessageType,
  PrismaClient,
} from '@prisma/client';

describe('AutomatedDelivery PostgreSQL claims (integration)', () => {
  const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
  let prisma: PrismaClient;
  let contactId: string;
  let deliveryId: string;
  let operationKey: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('DATABASE_INTEGRATION_URL is required');
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    const contact = await prisma.contact.create({
      data: { waId: `integration-${suffix}` },
    });
    contactId = contact.id;
    const conversation = await prisma.conversation.create({
      data: { contactId },
    });
    const inbound = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        contactId,
        direction: MessageDirection.INBOUND,
        sender: MessageSender.CONTACT,
        type: MessageType.TEXT,
        content: 'integration inbound',
        wamid: `wamid.in.${suffix}`,
      },
    });
    operationKey = `${inbound.id}:HERMES_REPLY:0`;
    const delivery = await prisma.automatedDelivery.create({
      data: {
        operationKey,
        deliveryKind: AutomatedDeliveryKind.HERMES_REPLY,
        partIndex: 0,
        conversationId: conversation.id,
        contactId,
        sourceMessageId: inbound.id,
        sender: MessageSender.HERMES,
        content: 'integration outbound',
      },
    });
    deliveryId = delivery.id;
  });

  afterEach(async () => {
    await prisma.automatedDelivery.deleteMany({ where: { contactId } });
    await prisma.contact.delete({ where: { id: contactId } });
  });

  afterAll(async () => prisma.$disconnect());

  it('allows one atomic PREPARED claim and one operation key', async () => {
    const [first, second] = await Promise.all([
      prisma.automatedDelivery.updateMany({
        where: {
          id: deliveryId,
          status: AutomatedDeliveryStatus.PREPARED,
          claimToken: null,
        },
        data: {
          status: AutomatedDeliveryStatus.DISPATCHING,
          claimToken: 'worker-a',
        },
      }),
      prisma.automatedDelivery.updateMany({
        where: {
          id: deliveryId,
          status: AutomatedDeliveryStatus.PREPARED,
          claimToken: null,
        },
        data: {
          status: AutomatedDeliveryStatus.DISPATCHING,
          claimToken: 'worker-b',
        },
      }),
    ]);
    expect(first.count + second.count).toBe(1);
    expect(
      await prisma.automatedDelivery.count({ where: { operationKey } }),
    ).toBe(1);
    await expect(
      prisma.automatedDelivery.create({
        data: {
          operationKey,
          deliveryKind: AutomatedDeliveryKind.HERMES_REPLY,
          partIndex: 1,
          conversationId: (
            await prisma.automatedDelivery.findUniqueOrThrow({
              where: { id: deliveryId },
            })
          ).conversationId,
          contactId,
          sourceMessageId: (
            await prisma.automatedDelivery.findUniqueOrThrow({
              where: { id: deliveryId },
            })
          ).sourceMessageId,
          sender: MessageSender.HERMES,
          content: 'duplicate key',
        },
      }),
    ).rejects.toBeDefined();
  });
});
```

The test deletes only its uniquely named fixture rows and throws a clear setup
error when `DATABASE_INTEGRATION_URL` is absent.

- [ ] **Step 4: Run tests RED without prepared services and record the environment result**

Run:

```powershell
npm run test:integration
```

Expected before services/configuration: exit 1 with the explicit missing
integration URL or connection error. This is evidence, not permission to skip
the integration gate.

- [ ] **Step 5: Run against disposable real services when available**

With values supplied outside Git and without printing them:

```powershell
$env:DATABASE_URL=$env:DATABASE_INTEGRATION_URL
npx prisma migrate deploy
npm run test:integration
```

Expected: 2 integration suites pass. If Docker/Redis/PostgreSQL cannot be made
available safely in this session, leave production code untouched, keep the
tests, and report the missing real-service evidence as `NO-GO` for canary.

- [ ] **Step 6: Commit integration verification**

```powershell
git add hermes-backend/package.json hermes-backend/test/jest-integration.json hermes-backend/test/nous-hermes-queue.integration-spec.ts hermes-backend/test/automated-delivery.integration-spec.ts
git commit -m "test(hermes): verify distributed delivery controls"
```

---

### Task 8: Configure the private runtime and publish the operational runbook

**Files:**
- Modify: `hermes-backend/.env.example`
- Modify: `hermes-backend/docker-compose.yml`
- Modify: `hermes-backend/docs/nous-hermes-runbook.md`
- Modify: `hermes-backend/docs/crm-baseline-agent.md`

**Interfaces:**
- Consumes: `/etc/hermes-agent-client/api-key`, external Docker network `hermes_client_api`, migration from Task 3, and exact environment variables.
- Produces: a reproducible Compose/runtime contract with no secret value and no enabled Nous conversation.

- [ ] **Step 1: Write config assertions before editing runtime files**

Add transport/module tests that instantiate `ConfigService` with no Nous values
and assert the safe defaults:

```typescript
expect(engineService.selectedEngine('conversation-1')).toBe('gemini_direct');
expect(configuredAllowlist('')).toEqual([]);
expect(transportConfig().url).toBe(NOUS_HERMES_ENDPOINT);
expect(transportConfig().secretPath).toBe(
  '/run/secrets/nous_hermes_api_key',
);
```

Add a Compose validation command to the task contract; do not test Markdown by
grepping prose.

- [ ] **Step 2: Run safe-default tests RED if configuration still uses obsolete fields**

Run:

```powershell
npm test -- --runInBand conversation-engine/conversation-engine.service.spec.ts conversation-engine/nous-hermes.transport.spec.ts
```

Expected: fail until `NOUS_HERMES_API_KEY`, `NOUS_HERMES_MODEL`,
`NOUS_HERMES_IDENTITY_SECRET`, and `NOUS_HERMES_ALLOW_INSECURE_HTTP` are no
longer required.

- [ ] **Step 3: Replace `.env.example` Nous configuration**

Keep:

```dotenv
HERMES_CONVERSATION_ENGINE=gemini_direct
NOUS_HERMES_CONVERSATION_ALLOWLIST=
NOUS_HERMES_CHAT_COMPLETIONS_URL=http://nous-hermes-api:8642/v1/chat/completions
NOUS_HERMES_API_KEY_FILE=/run/secrets/nous_hermes_api_key
NOUS_HERMES_TIMEOUT_MS=45000
NOUS_HERMES_MAX_RESPONSE_BYTES=256000
NOUS_HERMES_CONTEXT_MAX_CHARS=12000
NOUS_HERMES_MAX_ATTEMPTS=3
NOUS_HERMES_BACKOFF_MS=1500
NOUS_HERMES_QUEUE_WAIT_TIMEOUT_MS=120000
```

Remove the obsolete direct key, model, identity secret, and insecure-HTTP
variables.

- [ ] **Step 4: Declare the secret and private external network in Compose**

Add only to `app`:

```yaml
    environment:
      PORT: 3003
      NOUS_HERMES_API_KEY_FILE: /run/secrets/nous_hermes_api_key
    secrets:
      - nous_hermes_api_key
    networks:
      - default
      - hermes_client_api
```

Add top-level declarations:

```yaml
secrets:
  nous_hermes_api_key:
    file: ${NOUS_HERMES_API_KEY_SOURCE:-/etc/hermes-agent-client/api-key}

networks:
  hermes_client_api:
    external: true
```

Do not add a port for 8642 and do not attach PostgreSQL, Redis, or n8n to the
external network.

- [ ] **Step 5: Validate Compose without reading the secret**

Run:

```powershell
docker compose config --no-interpolate
```

Expected: exit 0; the rendered structure shows the secret reference and only
`app` attached to `hermes_client_api`. The command must not read or print the
secret file.

- [ ] **Step 6: Rewrite the runbook for contract version 1**

Document these concrete procedures:

- safe defaults and empty allowlist;
- exact URL and alias;
- secret source/mount and required root-readable runtime;
- external network creation/verification without port publication;
- `prisma migrate deploy` before application restart;
- readiness/DNS checks from `hermes-app` without printing Authorization;
- response rejection rules and bounded Nous 429 retries;
- automatic-delivery status meanings and a query for `AMBIGUOUS` rows;
- manual reconciliation limitations and prohibition on automatic resend;
- rollback order: empty allowlist, direct engine, drain queue, inspect ambiguous
  rows, restart, verify one authorized synthetic flow;
- explicit statement that this work does not authorize canary or commercial
  conversations.

Append the new test counts/commands and integration evidence to the baseline
document only after the commands have actually run. When an integration command
cannot run, record the exact blocker rather than a pass.

- [ ] **Step 7: Run configuration and documentation-adjacent verification**

Run:

```powershell
npm test -- --runInBand conversation-engine/conversation-engine.service.spec.ts conversation-engine/nous-hermes.transport.spec.ts
npx prisma validate
docker compose config --no-interpolate
```

Expected: all tests pass and both validation commands exit 0.

- [ ] **Step 8: Commit runtime configuration and runbook**

```powershell
git add hermes-backend/.env.example hermes-backend/docker-compose.yml hermes-backend/docs/nous-hermes-runbook.md hermes-backend/docs/crm-baseline-agent.md
git commit -m "docs(hermes): document private agent deployment"
```

---

### Task 9: Run full regression, inspect the branch, and record evidence

**Files:**
- Modify only if verification exposes a tested defect in files already in scope.

**Interfaces:**
- Consumes: all prior task commits and the spec acceptance criteria.
- Produces: fresh unit/E2E/build/lint/migration/config evidence and a secret-free reviewed diff.

- [ ] **Step 1: Generate and validate Prisma artifacts**

Run:

```powershell
npx prisma format
npx prisma validate
npx prisma generate
```

Expected: all commands exit 0.

- [ ] **Step 2: Run every unit test**

Run:

```powershell
npm test -- --runInBand
```

Expected: all suites and tests pass with zero snapshots failing. Record exact
suite/test counts from the output.

- [ ] **Step 3: Run all 11 E2E contracts**

Run:

```powershell
npm run test:e2e -- --runInBand
```

Expected: 1 suite and 11 tests pass.

- [ ] **Step 4: Run real-service integration verification**

Run:

```powershell
npm run test:integration
```

Expected: 2 suites pass. If they cannot run because disposable real services
are unavailable, record the exact failure and mark canary `NO-GO`.

- [ ] **Step 5: Build and lint**

Run:

```powershell
npm run build
npm run lint
git diff --exit-code
```

Expected: build and lint exit 0. Because lint uses `--fix`, `git diff
--exit-code` must also exit 0; otherwise inspect, test, and commit only the
required formatting changes before repeating this step.

- [ ] **Step 6: Validate Compose and inspect branch scope**

Run:

```powershell
docker compose config --no-interpolate
git status --short
git diff 3515206..HEAD --stat
git diff 3515206..HEAD --name-only
git log --oneline 3515206..HEAD
```

Expected: Compose exits 0; working tree is clean; no frontend file appears; all
changed paths are named in this plan or are generated migration artifacts.

- [ ] **Step 7: Scan tracked changes for accidental secrets**

Run a targeted scan over the changed files for private-key delimiters, literal
Bearer values, Meta token shapes, and the forbidden source path content. Treat
documented variable names and placeholders as non-secrets, inspect every match,
and remove any actual credential before continuing.

Expected: zero secret values. The path `/etc/hermes-agent-client/api-key` may
appear only as a documented host source; its contents never appear.

- [ ] **Step 8: Verify every acceptance statement**

Confirm from code/tests and fresh output:

```text
default engine: gemini_direct
committed allowlist: empty
Nous tools: rejected
Nous session headers: absent
global inference concurrency: 1 in Redis integration test
automatic ambiguous resend: prohibited by terminal status
campaign idempotency tests: green
n8n failure independence: green
real VPS deployment/canary: not performed
```

If any line lacks evidence, report it as a blocker and do not label the branch
deployable or canary-ready.

- [ ] **Step 9: Commit verification-only corrections, if tests required them**

When and only when a RED regression required an in-scope correction, commit the
tested change:

```powershell
git add --update hermes-backend
git commit -m "fix(hermes): resolve deployment verification findings"
```

Do not create an empty commit.
