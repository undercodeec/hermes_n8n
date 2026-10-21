# F3 approval authority and retrieval eligibility

Base commit: `a2a6cc4b0faaefd764f2f36fbc4b8fe6abc05c22`. This document belongs to the resulting single Git commit. The gate uses only synthetic data in local PostgreSQL/Redis and fake provider HTTP. F3 remains OPEN and the four `LEARNING_*` flags remain OFF.

## Actual authority path

`ConversationReviewService.process` parses the reviewer response, computes a content fingerprint, upserts `LearningItem` version 1 with the schema default `PROPOSED`, adds `LearningEvidence` and marks the review `PROPOSED`. Its confidence and the number of source conversations do not update the learning status. Source deletion may automatically move `PROPOSED → REJECTED` or `ACTIVE → RETIRED` when the last effective evidence disappears; it never promotes an item to `ACTIVE`.

`POST /api/learning/candidates/:id/decision` is the existing endpoint. Class guards require a valid Bearer JWT and `ADMIN`. `JwtStrategy` loads the user by JWT subject from PostgreSQL, checks `isActive` and uses the **database role**, not the role claimed in the token. `CurrentUser('id')` supplies the actor to `decide`; the DTO does not accept an operator ID. The HTTP test observed 401 without/with invalid JWT and for an inactive user, 403 for `SALES_AGENT` including a forged ADMIN claim, 400 for an extra `approvedById` body field, and 201 for a valid ADMIN decision.

Inside `decide`, the service trims and validates a 10–500 character reason and rejects phone/email contact data. `APPROVE` requires `validUntil` as valid ISO 8601 in the DTO and a future instant no more than 180 days away in the service. Other actions reject `validUntil`. The transaction obtains a PostgreSQL advisory lock keyed by item ID, reads the current status, requires effective evidence for approval, validates only semantic candidate fields and source review metadata, conditionally updates the expected state, inserts `AuditLog`, then returns the item. Failure of the audit insert rolls the status update back. The approval validation previously included the item's UUID in the privacy check; the gate corrected this by passing only `kind`, `trigger`, `guidance`, `serviceCode` and `market`, matching the selector.

| Before   | Action                    | After     | HTTP on valid decision |
| -------- | ------------------------- | --------- | ---------------------: |
| PROPOSED | APPROVE                   | ACTIVE    |                    201 |
| PROPOSED | REJECT                    | REJECTED  |                    201 |
| ACTIVE   | RETIRE                    | RETIRED   |                    201 |
| PROPOSED | RETIRE                    | unchanged |                    409 |
| ACTIVE   | APPROVE or REJECT         | unchanged |                    409 |
| REJECTED | APPROVE or RETIRE         | unchanged |                    409 |
| RETIRED  | APPROVE, REJECT or RETIRE | unchanged |                    409 |

Repeated decisions return 409; they do not create a second audit, change actor or increase version. Concurrent APPROVE/REJECT, duplicate APPROVE, duplicate REJECT and duplicate RETIRE produce one winner and one rejected transaction. A stale operator decision also receives 409. The advisory lock and conditional `updateMany` prevent an overwrite. Only APPROVE sets `approvedById`, `approvedAt` and `validUntil`; REJECT/RETIRE leave those fields as they were. All three preserve fingerprint, version and guidance. Content correction requires a new candidate/version; the endpoint has no inline edit.

The audit row contains actor `userId`, `LEARNING_APPROVE`/`REJECT`/`RETIRE`, item ID, version, before/after, trimmed reason and expiry. Its `createdAt` is the audit timestamp. Failed decisions do not insert an audit row in this contract. Historical `LearningItem` and evidence remain after RETIRE. `AuditLog.userId` and `LearningItem.approvedById` are relational references; a deleted user may set them null according to the current Prisma schema, while the decision row remains.

## Approval is eligibility, not unconditional trust

`LearningRetrievalService.select` fetches only `ACTIVE`, current, non-HIGH items of matching scope with effective evidence. The selector also applies privacy, commercial safety, ranking and content budget. Shadow uses the same selector but does not inject guidance; retrieval is still gated by the flag. Effective evidence requires linked message, BAD feedback and PROPOSED review. Missing/deleted evidence, failed review or changed feedback block approval. Removing the last effective evidence after approval makes the still-ACTIVE item ineligible immediately; canonical source deletion may also retire it and audit that safety demotion. No cache invalidation or restart was required for a subsequent selection.

The real Gemini Direct and Nous Hermes adapters received the selected item only during its eligible ACTIVE state. PROPOSED, REJECTED, RETIRED and expired states produced no `approvedLearning` in their captured fake HTTP requests and no `learningExposed`; eligible ACTIVE returned ID/version only in `learningExposed`. A RETIRE concurrent with retrieval cannot retract an already built request, but all selections after the committed RETIRE exclude the item.

Human approval does not authorize private or commercial claims: the approval service rejects synthetic private name, discount and payment terms. HIGH risk can be approved by the current decision contract but remains excluded by retrieval. Privacy and commercial precedence are independently rechecked by the selector. The new tests plus the existing core, shadow and delivery suites cover these guards without reopening earlier gates.

The frontend CRM source is not present in this backend checkout. The API route, action enum and DTO were inspected and remained unchanged; no browser or UI claim is made. No new approval endpoint, state machine, table, migration, flag or production call was introduced.
