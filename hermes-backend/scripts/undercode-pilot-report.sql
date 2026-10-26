-- Read-only 30-day comparison for the one-number UnderCodeEC pilot.
-- Run with psql -v cost_per_request=0.02 -f scripts/undercode-pilot-report.sql
-- The cost is an operator estimate, never provider billing.
WITH pilot_conversations AS (
  SELECT id, COALESCE(metadata->>'pilotOrigin', 'unknown') AS origin
  FROM conversations
  WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    AND metadata ? 'pilotOrigin'
), dispatches AS (
  SELECT "conversationId", COUNT(*) AS requests
  FROM inbound_turns
  WHERE "generationEngine" = 'nous_hermes'
    AND "providerDispatchReservedAt" IS NOT NULL
  GROUP BY "conversationId"
), response_usage AS (
  SELECT "conversationId", "inboundTurnId",
         MAX("tokensUsed") AS tokens,
         MAX("costEstimate") AS provider_cost_estimate
  FROM messages
  WHERE metadata->>'conversationEngine' = 'nous_hermes'
    AND "inboundTurnId" IS NOT NULL
  GROUP BY "conversationId", "inboundTurnId"
), usage_by_conversation AS (
  SELECT "conversationId", COUNT(*) AS response_turns,
         COUNT(tokens) AS token_known_turns,
         COUNT(provider_cost_estimate) AS provider_cost_known_turns,
         SUM(tokens) AS known_tokens,
         SUM(provider_cost_estimate) AS known_provider_cost_estimate
  FROM response_usage
  GROUP BY "conversationId"
)
SELECT c.origin,
       COUNT(*) AS conversations,
       COALESCE(SUM(d.requests), 0) AS nous_requests,
       COALESCE(SUM(d.requests), 0) * CAST(:'cost_per_request' AS numeric) AS estimated_usd,
       COALESCE(SUM(u.response_turns), 0) AS response_turns,
       COALESCE(SUM(u.token_known_turns), 0) AS token_known_turns,
       COALESCE(SUM(u.provider_cost_known_turns), 0) AS provider_cost_known_turns,
       SUM(u.known_tokens) AS known_tokens,
       SUM(u.known_provider_cost_estimate) AS known_provider_cost_estimate,
       NULL::numeric AS billed_usd
FROM pilot_conversations c
LEFT JOIN dispatches d ON d."conversationId" = c.id
LEFT JOIN usage_by_conversation u ON u."conversationId" = c.id
GROUP BY c.origin
ORDER BY c.origin;
