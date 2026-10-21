# F3 traceability gate — offline

Base: `0ee1a8c10bfec43c7f53a3ae85763fb6f31886b4`. Result: `F3_TRACEABILITY_GATE_PROVEN_OFFLINE`. F3 remains `OPEN`. The corpus and measurements are in `artifacts/f3-traceability-gate/`.

## Meaning of the trace

1. **SELECTED:** `LearningRetrievalService.select` returned an eligible item. Shadow can select while retrieval is off. Selection is not persisted as exposure.
2. **EXPOSED_TO_ENGINE:** the item ID/version was in the provider-visible request. Gemini reports the learning in the assembled HTTP request after an observed provider response; Nous reads it from the final serialized message after its context budget. HTTP errors with a provider response retain exposure. A transport error without a response has uncertain delivery to the provider and does not assert exposure.
3. **RESPONSE_GENERATED:** the engine returned an output, which may be repaired or suppressed by backend policy. No causal use of learning is inferred.
4. **DELIVERED_CONFIRMED:** every HERMES_REPLY part is `CONFIRMED` in the durable ledger. `PREPARED`, `DISPATCHING`, `SUPPRESSED`, `REJECTED` and `AMBIGUOUS` never count as confirmed delivery.

`learningExposed does not claim causal use or effectiveness`.

## Data flow

`LearningItem (id/version)` → effective-evidence and safety selector → `approvedLearning` on `ConversationTurnInput` → Gemini `HermesRequestDto` and HTTP prompt, or Nous final serialized `approvedState` → `ConversationTurnResult.learningExposed` → `AutoReplyService` post policies → `AutomatedDelivery.metadata` on part 0 → final ledger status. `sourceMessageId` is the persisted inbound ID and also the inference `traceId`; `conversationId` and optional `conversationTurnId` identify the turn without copying conversation text.

| Field | Source | Written | Mutable through normal flow? | Reconstruction |
|---|---|---|---|---|
| `LearningItem.id/version` | Learning row | Approval/reviewer | Status may change; versioned successor is a new row | Exposure stores historical ID/version |
| `sourceReviewId`, `reviewerVersion`, `LearningEvidence`, approver | Learning provenance tables | Review/approval | Provenance may later change or be invalidated | Origin audit only; never in engine retrieval |
| `approvedLearning` | Selector | Before inference | Ephemeral | Selected, not historical exposure |
| `conversationEngine` | Effective engine result | Delivery preparation | No normal update | Required |
| `providerModel` | Gemini configured model / validated Nous alias or `unknown` | Delivery preparation | No normal update | Available model identity; actual underlying Nous model digest is not observable offline |
| `promptVersion` | Gemini system prompt SHA-256 prefix / Nous effective system message SHA-256 prefix | Delivery preparation | No normal update | Template/contract identity without prompt text |
| `traceId` | Persisted inbound ID | Engine result and delivery preparation | No normal update | Required; equals `sourceMessageId` |
| `learningExposed` | Actual engine request boundary | Delivery preparation | No normal update | Ordered ID/version array on part 0 only; absent means empty |
| `operationKey`, `partIndex`, `deliveryKind` | Delivery ledger | Preparation | Stable | Links all parts to one inference |
| `status`, `attempts`, `wamid`, `outboundMessageId` | Delivery ledger | Dispatch/confirmation | Status and attempts advance | Delivery outcome; only `CONFIRMED` establishes a confirmed send |

The review/rubric provenance graph is separate from exposure. `sourceReviewId` points to `ConversationReview.reviewerVersion`; `LearningEvidence` links source rows and human approval is on `LearningItem`. Neither source text nor reviewer summary is copied into `learningExposed`.

## Reconstruction and failure behavior

`loadLearningTrace` reads only `AutomatedDelivery` rows by inbound `sourceMessageId`; it validates part order, operation keys, trace ID, engine, and each exposure ID/version. It rejects malformed or duplicate exposure metadata. It never queries the current LearningItem status, evidence or guidance. Part 0 is the single exposure carrier; retries increase `attempts`, not logical exposure count. A batch is confirmed for analytics only when every part is confirmed. Exposure analytics can include a suppressed, rejected or ambiguous delivery, with that status intact.

`prepareBatch` now writes all parts in one PostgreSQL transaction. A later metadata write failure rolls back the whole preparation, so recovery cannot send a partial new batch. The existing confirmation transaction still writes outbound message and `CONFIRMED` together. Post-inference guards now write one terminal `SUPPRESSED` operation with compact metadata and no outbound content. A failed metadata write propagates and cannot silently create a confirmed delivery. No schema or migration was needed.

The application does not enforce database-level immutability of JSON metadata. Normal retirement, evidence invalidation, feedback, review and successor creation do not update past delivery rows. A crash or uncertain network failure before an observed provider response cannot prove provider exposure; the trace deliberately makes no exposure claim in that case. `providerModel` identifies the configured Gemini model or the validated Nous alias, while an actual private model digest remains outside this offline contract.

All fixtures use synthetic identifiers, content, local HTTP/provider doubles and isolated PostgreSQL/Redis. Production flags, Meta, WhatsApp, VPS and real providers were untouched. The report records test counts, zero external traffic, migration status and descriptive timings. No production performance threshold was defined.
