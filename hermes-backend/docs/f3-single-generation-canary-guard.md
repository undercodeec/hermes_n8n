# F3 single-generation canary guard

This guard limits one explicitly configured QA conversation to one provider generation per canonical inbound source message. It is OFF by default and independent of the learning retrieval scope. It is an offline implementation gate; deploying or enabling retrieval requires separate review.

## Configuration

Set `F3_SINGLE_GENERATION_CANARY_ENABLED=true` and `F3_SINGLE_GENERATION_CANARY_CONVERSATION_ID` to the one QA conversation UUID. Both `HERMES_COMPLETION_ATTEMPTS` and `NOUS_HERMES_MAX_ATTEMPTS` must explicitly equal `1`; startup rejects an armed canary otherwise. Empty ID is valid only when disabled. A malformed UUID always rejects startup. The retrieval flag and its conversation scope do not arm this guard.

To disarm new turns, set the canary flag to `false`. Existing reservations remain durable and continue to prevent replay, including after a restart. Do not delete reservations to retry an ambiguous turn.

## Durable state

`InboundTurn.generationSourceMessageId` is nullable and unique. It records the turn's canonical `lastMessageId`. `generationReservedAt`, `generationToken` and `generationEngine` are written atomically while the turn is `PROCESSING` and owned by its processing token. The token also fences a late worker. Nous additionally consumes `providerDispatchReservedAt` with an atomic conditional update immediately before HTTP. `generationBlockedAt` and `generationBlockReason` record `CANARY_BLOCKED_AMBIGUOUS_GENERATION` when the reserved turn has no durable batch.

The worker always checks for an existing delivery batch first. A prior reservation without a batch never authorizes another call. A crash before reservation can retry; a crash after reservation may leave the turn `BLOCKED` even if no provider request was sent. This deliberate loss of availability keeps the one-call bound. If a batch is committed, recovery uses that batch. Preparation of all physical parts is transactional and checks the original owner under a row lock, serialized with blocking. Thus the batch is complete or no batch is persisted.

Nous has a second BullMQ queue. A replayed or stalled job cannot issue another HTTP request after `providerDispatchReservedAt` is set. If its caller stops waiting before the job begins, the turn is blocked; the late job's dispatch check then denies HTTP. Neither queue job IDs nor configured attempt counts provide the durable guarantee by themselves.

## Audit and privacy

Reservation and dispatch timestamps are technical evidence of consumed permission. They do not prove that the provider received a request or used any learning. `learningExposed` retains its existing meaning: learning included at the engine request boundary. The new fields store no prompt, transcript, response, guidance, contact details or secrets.

## Offline verification and rollout order

Apply the additive migration with the flag OFF. Validate Prisma, run unit and isolated PostgreSQL/Redis integration tests, then review the implementation. Before a future canary round, verify the configured UUID and both provider attempt limits. Do not enable retrieval in the guard's dark deploy. Round B needs a fresh `InboundTurn` after Round A is terminal, the queue is idle and the configured inbound debounce window has elapsed. No real QA message is sent by these tests.
