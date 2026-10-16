# F3 privacy isolation: actual runtime boundary

Base commit: `a117e85c8eeb37eb96bb376c4a0a758ae94c6829`. Scope: offline synthetic data only. `F3 = OPEN`; all four `LEARNING_*` flags remain OFF. The final commit is the Git commit containing this document.

## Data flow

1. `LearningItem.ACTIVE` originates in an approved, generalized candidate. PostgreSQL keeps `sourceReviewId`; `LearningEvidence` keeps source `conversationId`, `messageId`, `feedbackId`, `reviewId` and the relationships needed for effective evidence. The canonical source `Message`, `ConversationReview`, `Contact`, `Lead` and `ConversationState` remain in their own tables. They are not runtime learning text.
2. `LearningRetrievalService.select` queries at most 100 active, valid, non-HIGH items with effective evidence and matching `serviceCode`/`market`. It selects `id`, `version`, `kind`, `trigger`, `guidance`, `serviceCode`, `market`, status/risk/validity/date and at most one evidence **ID**. It does not select `sourceReviewId`, source conversation/message/feedback, review text, contact, lead or state. The evidence ID is used only for eligibility.
3. `selectApprovedLearning` validates only the semantic `kind`, `trigger`, `guidance`, `serviceCode` and `market` through the canonical candidate safety function, then returns at most three complete items with `id`, `version`, `kind`, `trigger`, `guidance` and optional scope. The item's own UUID is never parsed as content. HIGH risk, expired, unmatched, unsupported, private or commercially unsafe items are excluded; DB/selector errors return an empty list. Logs record counts, duration and current inbound `traceId`, without guidance or evidence text.
4. `AutoReplyService` obtains the **current** conversation's recent messages and summary by `conversationId`, profile from the lead by current `contactId`, and current contact name. It passes these alongside `approvedLearning` as distinct fields in `ConversationTurnInput`. Source A relations are never fetched for this turn. Shadow selection remains separate from runtime injection.
5. `DirectGeminiEngine` maps the B turn into `HermesRequestDto`; `HermesService` serializes the selected learning into its provider prompt alongside B history, summary/profile and authorized commercial information. `NousHermesTransport` serializes the B turn into `approvedState` and can omit whole learning items under its context budget. Both return `learningExposed` with only the IDs and versions actually submitted. `AutoReplyService` places that list, when present, in `AutomatedDelivery` metadata. It does not save source evidence, review text or private guidance there.

The current B `conversationId` and inbound message ID are correlation/context identifiers in the normal engine contract. They are distinct from the source A IDs. `traceId` is derived from B inbound message, never from A evidence.

## Privacy matrix

| Data class                                                          |            Persisted in DB | May affect generalized guidance or eligibility | May reach another conversation's engine via learning |
| ------------------------------------------------------------------- | -------------------------: | ---------------------------------------------: | ---------------------------------------------------: |
| General interaction guidance, kind, trigger, safe scope             |                        Yes |                                            Yes |                   Yes, after safety and scope checks |
| `LearningItem.id` / version                                         |                        Yes |                 Selection order / traceability |             Yes, contract requires exposure metadata |
| Source review ID and summary                                        |                        Yes |                        Review association only |                                                   No |
| `LearningEvidence` IDs and source conversation/message/feedback IDs |                        Yes |                 Effective evidence eligibility |                                                   No |
| Source message text and feedback content                            | In canonical source tables | Only abstracted into candidate before approval |                                                   No |
| Source contact name, phone, email, address or identity              | In canonical source tables |                                             No |                                                   No |
| Source lead `commercialProfile`, budget and particular needs        | In canonical source tables | Only an abstract, safe candidate could survive |                                                   No |
| Source `ConversationState.summary`                                  |                        Yes |                                             No |                                                   No |
| Current contact history/profile/summary                             |                        Yes |                    Normal current-turn context |       Yes, according to the existing engine contract |

The Prisma schema has no `tenantId`, organization boundary or RLS: `TENANT_BOUNDARY_NOT_APPLICABLE_CURRENT_SCHEMA`. The tested boundary is contact to contact, conversation to conversation, lead to lead, and evidence to runtime within the existing application.

## Offline evidence and limits

`src/learning/f3-privacy-isolation.spec.ts` tests direct private content exclusion, two safe items plus one private item, internal UUID non-exclusion, malformed validation, and captures the requests emitted by the real Gemini Direct and Nous adapters with deterministic fake HTTP. It asserts zero source A markers in both serialized requests, while current B profile and summary remain present. `src/auto-replies/auto-reply.service.spec.ts` verifies B's turn, delivery metadata and absence of source writes in the full orchestration path. `test/conversation-learning.integration-spec.ts` uses isolated PostgreSQL/Redis to verify A source records are unchanged by B retrieval and that invalidated evidence removes eligibility. Request payloads and private guidance are kept in synthetic tests, not in the report.

`review-privacy.ts` is the shared candidate/reviewer privacy filter. It now recognizes private identifiers, addresses, quoted source statements, particular needs and opaque fixture markers in semantic learning text. Its reviewer redaction preserves Unicode regex flags. The broader commercial and prompt-injection guards still apply. A privacy validation failure excludes the affected item and lets the conversation continue; a whole selector failure returns an empty list.

The gate only proves leakage caused by learning retrieval. `provider-originated arbitrary PII output is outside retrieval-causality unless an existing output privacy guard claims to cover it`. No tenant system, global DLP, F4 summary generation or production policy is inferred. No real provider, Meta, WhatsApp, VPS, canary, deployment or flag activation was used.
