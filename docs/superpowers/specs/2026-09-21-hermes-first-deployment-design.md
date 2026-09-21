# Hermes CRM First Deployment Design

**Date:** 2026-09-21

**Branch:** `feat/hermes-conversation-engine`

**Base commit:** `3515206`

**VPS contract:** `contract_version=1`

## Goal

Prepare the Hermes CRM backend for its first controlled deployment with the
private Nous Hermes Agent without enabling commercial conversations. The
delivery must remove the known ambiguous-send risk, implement the real VPS
contract, retain `gemini_direct` as the default engine, keep the Nous allowlist
empty, and leave auditable tests and rollback instructions.

## Confirmed baseline

The inbound path is:

```text
WebhookService
  -> PostgreSQL inbound/message deduplication
  -> BullMQ automatic reply job
  -> AutoReplyService
  -> ConversationEngine
  -> CRM policy/output validation
  -> MetaService
  -> PostgreSQL outbound message
```

At `3515206`, BullMQ deduplicates jobs by inbound message ID and PostgreSQL
deduplicates inbound messages by Meta `wamid`, but the automatic reply path
calls Meta before it creates any durable outbound reservation. A process crash
after Meta may have accepted the request and before PostgreSQL stores the
returned `wamid` can therefore make a BullMQ retry send the same logical reply
again.

The isolated E2E module also omits `ConversationEventsService`. Module creation
fails for all 11 E2E cases, and teardown then calls `close()` on an uninitialized
application. The production module already registers this service; the defect
is limited to the test module and its teardown.

## Scope

This change includes:

- the E2E baseline repair;
- a durable PostgreSQL ledger for automatic text deliveries;
- final eligibility checks immediately before each Meta send;
- conservative classification and recovery of ambiguous Meta outcomes;
- the real private Nous HTTP contract and strict response validation;
- distributed serialization and bounded 429 retries for Nous inference;
- Docker secret and private-network declarations for the CRM service;
- unit, E2E, build, lint, migration, and available real Redis/PostgreSQL checks;
- an updated operational runbook.

This change does not enable a Nous conversation, populate its allowlist, deploy
to the VPS, publish port 8642, change Meta callbacks/WABA/templates, alter
campaign idempotency, add tools, add stateful agent sessions, or modify the
frontend.

## Selected architecture

### 1. Durable automatic delivery ledger

Add a Prisma model named `AutomatedDelivery` and a corresponding migration.
Each logical outbound part has a deterministic `operationKey`, a separate UUID
primary key, and links to its conversation, contact, and source inbound
message. The operation key is derived only from internal identifiers:

```text
<sourceMessageId>:<deliveryKind>:<partIndex>
```

The record stores the exact text selected for delivery before Meta is called.
Retries therefore resume the same content rather than regenerating or changing
the message. Relevant fields are:

- `id`, `operationKey`, `deliveryKind`, and `partIndex`;
- `conversationId`, `contactId`, and `sourceMessageId`;
- sender, content, and safe metadata;
- status and attempt count;
- claim token and claim expiry;
- dispatch, confirmation, ambiguity, rejection, and suppression timestamps;
- confirmed `wamid` and the persisted outbound `messageId`;
- redacted reason/error code, never provider bodies or credentials.

`operationKey`, `wamid`, and `messageId` are unique where applicable. Database
foreign keys and indexes cover conversation history, source-message recovery,
and operational queries by status/time.

The delivery status machine is:

```text
PREPARED
  -> DISPATCHING          atomic claim immediately before Meta
  -> SUPPRESSED           final CRM/WhatsApp guard rejected the send

DISPATCHING
  -> CONFIRMED            Meta returned wamid; message + delivery committed
  -> PREPARED             explicit HTTP 429 rejection; bounded retry allowed
  -> REJECTED             explicit non-retryable 4xx rejection
  -> AMBIGUOUS            timeout, connection loss, 5xx, missing wamid,
                           persistence failure after Meta, or expired claim
```

`CONFIRMED`, `REJECTED`, `AMBIGUOUS`, and `SUPPRESSED` are terminal for
automatic processing. In particular, an ambiguous operation is never moved
back to `PREPARED` automatically.

All parts of a split message are prepared durably before the first part is
sent. At the beginning of a retry or worker restart, `AutoReplyService` checks
for an existing batch for the source inbound. It resumes stored `PREPARED`
parts, skips `CONFIRMED` parts, and refuses to resend any `DISPATCHING` or
`AMBIGUOUS` part. This recovery-first path prevents a second inference or a
different reply from becoming the retry payload.

An atomic conditional update from `PREPARED` to `DISPATCHING` ensures that two
workers cannot both claim the same operation. The claim has a random token and
expiry. A concurrent loser observes the active claim and does not alter it. On
application startup and before new delivery work, expired claims are converted
to `AMBIGUOUS`, not retried. This intentionally favors at-most-once delivery
over a possible duplicate.

### 2. Final delivery eligibility

The claim transaction reloads authoritative PostgreSQL state immediately
before Meta:

- the conversation exists and its status is permitted for that delivery kind;
- no conflicting human handoff is active;
- the contact has not opted out;
- the source inbound is still the most recent inbound in the conversation;
- the latest inbound keeps the WhatsApp 24-hour service window open;
- the prepared operation still belongs to the same conversation/contact;
- the operation has not already been claimed or completed.

A normal Hermes reply requires an `ACTIVE` conversation. A short transition
message that was explicitly prepared as part of creating a human handoff may
permit `HANDED_OFF`; no later commercial reply may do so. When the service
window is closed, the operation is suppressed with
`WHATSAPP_TEMPLATE_REQUIRED`. The automatic path never substitutes or invents
a template.

There is an unavoidable interval between the committed final check and the
external HTTP call. PostgreSQL cannot atomically commit Meta's side effect.
The durable `DISPATCHING` state and conservative ambiguity rule are the safety
boundary for that interval.

### 3. Meta outcome classification

`MetaService.sendTextMessage` will expose a typed, redacted failure class. It
will not log response bodies, credentials, or message text.

- A received 429 means Meta explicitly rejected that attempt. The delivery may
  return to `PREPARED` and let the bounded BullMQ policy retry it.
- Other received 4xx responses are definitive rejections and become
  `REJECTED` without automatic retry.
- A timeout, connection reset, missing HTTP response, or HTTP 5xx is ambiguous:
  Meta may have accepted the request before the connection failed.
- A successful HTTP response without a valid `wamid` is also ambiguous.
- If Meta returned a `wamid` but the transaction that creates the CRM message
  and confirms the delivery fails, the delivery is marked `AMBIGUOUS` when the
  process remains alive. A hard crash is recovered from the expired
  `DISPATCHING` claim after restart.

On success, creation of the outbound `Message`, storage of `wamid`, and the
transition to `CONFIRMED` occur in one PostgreSQL transaction. Campaign sends
continue to use their existing `CampaignRecipient` claim and are not migrated
to this ledger.

### 4. Operational reconciliation

For an ambiguous delivery the CRM has the operation UUID, conversation,
contact, source inbound, exact text, target number through the contact record,
and dispatch timestamp, but it does not have a confirmed `wamid`. The supplied
Meta API contract does not provide a search-by-client-operation endpoint and
does not guarantee idempotent sends. Therefore reconciliation cannot safely be
automated.

The runbook will instruct an operator to query ambiguous rows, compare the
conversation and timestamp with the available Meta Business/WhatsApp evidence,
and decide whether follow-up is needed. The system must never resend the
original operation as a reconciliation technique. If no authoritative evidence
is available, the record remains ambiguous. This limitation is explicit and is
a canary gate.

### 5. Nous inference queue and distributed concurrency

Nous inference receives its own BullMQ queue. The queue is configured with
`globalConcurrency=1`, which Redis enforces across all workers and application
replicas, rather than relying on a process-local mutex. Local worker
concurrency is also one.

The components are separated as follows:

- `NousHermesEngine` selects/enqueues an inference job and waits for its result;
- a queue processor owns bounded retry behavior;
- a transport component performs the single HTTP request and validates it;
- the existing `ConversationEngineService` retains engine selection and the
  empty-allowlist fallback to `DirectGeminiEngine`.

Inference jobs use the inbound message ID as correlation and contain only the
already approved/minimized conversation input. They do not contain the Bearer
secret. Completed jobs are removed promptly so approved conversation data is
not retained in Redis longer than required.

HTTP 429 from Nous is the only provider response retried by this queue. It uses
a fixed maximum attempt count and exponential backoff. HTTP 401/403, timeout,
5xx, malformed output, and provider-level errors become typed safe diagnostics
without fallback to another model. All inference retries finish before any
Meta delivery is prepared, so they cannot produce a second Meta send.

If Redis or the Nous queue is unavailable, an allowlisted Nous turn fails
closed with a neutral customer-safe diagnostic and an operator review task. A
non-allowlisted conversation never touches the Nous queue and continues through
`gemini_direct`.

### 6. Exact private HTTP contract

The only accepted Nous destination is:

```text
http://nous-hermes-api:8642/v1/chat/completions
```

Configuration is validated against the exact protocol, hostname, port, and
path. Userinfo, query strings, fragments, redirects, alternate hosts, arbitrary
plain HTTP destinations, and public URLs are rejected. The request always uses:

```json
{
  "model": "hermes-agent",
  "stream": false,
  "messages": []
}
```

Only `Authorization: Bearer ...` and `Content-Type: application/json` are sent.
The CRM does not send `X-Hermes-Session-Id`, `X-Hermes-Session-Key`, the former
local identity header, or any PII-bearing identity header. Correlation remains
internal to the CRM logs and BullMQ job metadata.

A response is accepted only when:

- the HTTP status is successful;
- no top-level `error` member exists;
- `choices[0]` and its message are structurally valid;
- `finish_reason` is a non-empty string other than `error`;
- message content is non-empty bounded text;
- tool calls, function calls, reasoning fields, privileged/structured output,
  and secret-like material are absent.

The response model is recorded as `hermes-agent` only when the response reports
that exact alias; otherwise it is `unknown`. The CRM never claims that the alias
proves the upstream Gemini model.

### 7. Secret and Compose configuration

The Bearer is read from a runtime file named by
`NOUS_HERMES_API_KEY_FILE`, defaulting to
`/run/secrets/nous_hermes_api_key`. The direct
`NOUS_HERMES_API_KEY`, identity-secret, and arbitrary-insecure-HTTP settings are
removed from the runtime contract.

Compose declares a file-backed `nous_hermes_api_key` secret whose host source is
configured outside Git and points to `/etc/hermes-agent-client/api-key` on the
VPS. The file remains `root:root 0600`; its permissions are not widened. The
current backend container runs as root, so it can read the mounted secret. A
future non-root-container hardening change must assign a compatible Docker
secret UID/GID without changing the host file to broad permissions.

Compose also declares `hermes_client_api` as an external network and attaches
only the CRM `app` service to it in addition to the existing default network.
PostgreSQL, Redis, and n8n are not attached. Port 8642 is never published.

Non-secret runtime variables are:

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

The Compose host-side secret path is supplied separately and is never copied to
`.env.example`, logs, tests, documentation, or Git as a secret value.

## Error handling and observability

Structured logs contain internal operation ID, conversation ID, inbound ID,
engine, safe status/code, and attempt count. They omit phone numbers, full
message text, Bearer values, provider bodies, and stack traces delivered to the
customer. Operator review tasks use existing safe diagnostics.

Required events include delivery prepared, suppressed, claimed, confirmed,
rejected, ambiguous, and expired-claim recovery, plus Nous queue retry/failure.
An n8n dispatch remains a separate asynchronous queue event. Its failure must
not roll back or block normal WhatsApp processing.

## Test strategy

Implementation follows test-driven development. Tests must first fail for the
missing behavior and then pass after the minimal implementation.

The suites cover:

- E2E test-module construction, all existing 11 cases, and safe teardown;
- atomic delivery claims under concurrent workers;
- crash/failure before claim, after claim, after Meta, and during persistence;
- restart recovery of prepared and expired unconfirmed operations;
- Meta timeout, connection loss, 429, 4xx, 5xx, and success without `wamid`;
- no automatic resend for ambiguous outcomes;
- latest inbound, opt-out, handoff, conversation status, and 24-hour checks at
  the final claim boundary;
- multipart recovery without duplicate confirmed parts;
- campaign behavior and existing campaign idempotency unchanged;
- exact URL/model/request headers and secret-file loading;
- HTTP 200 with `finish_reason="error"`, top-level error, malformed content,
  tool calls, function calls, reasoning, and privileged content;
- queue-wide Nous concurrency of one and bounded 429 backoff;
- allowlist fallback to `gemini_direct`, with an empty default allowlist;
- conversation isolation and no shared agent session state;
- n8n failure independence.

Where the environment permits, PostgreSQL migrations and Redis global
concurrency are exercised against real local services. If Docker/Redis is not
available, that missing integration evidence is reported as a deployment
blocker rather than replaced by a claim based only on mocks.

Final verification runs unit tests, all E2E cases, Prisma validation/generation,
build, and lint. The final diff is scanned for secrets, frontend changes, and
unrelated modifications.

## Deployment and rollback

The committed default remains:

```dotenv
HERMES_CONVERSATION_ENGINE=gemini_direct
NOUS_HERMES_CONVERSATION_ALLOWLIST=
```

Deployment prepares the external network and Docker secret, runs the Prisma
migration, starts the backend, and verifies DNS/readiness from the backend
runtime without printing the Bearer. No conversation is added to the allowlist
in this work.

Rollback empties the allowlist, restores `gemini_direct`, drains/stops new Nous
inference jobs, and restarts workers. Confirmed and ambiguous delivery records
remain for audit. Rollback never resends ambiguous operations, removes the
database, changes Meta configuration, or deletes evidence.

## Acceptance and canary gate

The branch is implementation-complete only when all automated verification is
green and the final diff/commit review is clean. It is not canary-approved from
mocks alone. A future canary still requires verification from the deployed CRM
container against the private agent, real Redis global concurrency, the mounted
secret, network isolation, one authorized test conversation, and human review
of ambiguous-delivery procedures.
