-- Read-only 30-day comparison for the one-number UnderCodeEC pilot.
-- Run with psql -v cost_per_request=0.02 -f scripts/undercode-pilot-report.sql
-- Origin is the initial conversation origin. A legacy "organic" row without
-- explicit post evidence is reported as unknown; absence of an ad is not proof.
-- Cost is an operator estimate, never provider billing.
WITH pilot_conversations AS (
  SELECT id,
         CASE
           WHEN metadata->>'pilotOrigin' = 'meta_ad' THEN 'meta_ad'
           WHEN metadata->>'pilotOrigin' = 'organic'
            AND metadata->>'pilotOriginEvidence' = 'meta_referral_post'
             THEN 'organic'
           ELSE 'unknown'
         END AS origin,
         NULLIF(metadata #>> '{pilotAd,sourceId}', '') AS ad_source_id
  FROM conversations
  WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    AND metadata ? 'pilotOrigin'
), inbound_rows AS (
  SELECT "conversationId", metadata,
         ROW_NUMBER() OVER (
           PARTITION BY "conversationId" ORDER BY "createdAt", id
         ) AS message_number
  FROM messages
  WHERE direction = 'INBOUND'
), inbound_metrics AS (
  SELECT "conversationId", COUNT(*) AS inbound_messages,
         COUNT(*) FILTER (WHERE metadata->>'pilotOrigin' = 'meta_ad')
           AS ad_referral_messages,
         COUNT(*) FILTER (
           WHERE message_number > 1 AND metadata->>'pilotOrigin' = 'meta_ad'
         ) AS later_ad_referral_messages
  FROM inbound_rows
  GROUP BY "conversationId"
), verified_commercial AS (
  SELECT l."conversationId",
         COUNT(DISTINCT e."leadId") FILTER (
           WHERE e."eventType" = 'LEAD_QUALIFIED'
         ) AS qualified_leads,
         COUNT(DISTINCT e."leadId") FILTER (
           WHERE e."eventType" = 'CONTRACT_WON'
         ) AS contracts_won,
         COUNT(DISTINCT e."leadId") FILTER (
           WHERE e."eventType" = 'CONTRACT_LOST'
         ) AS contracts_lost
  FROM leads l
  JOIN advertising_conversions e ON e."leadId" = l.id
  WHERE l."conversationId" IS NOT NULL
    AND e.verified = TRUE
    AND e."invalidatedAt" IS NULL
  GROUP BY l."conversationId"
), dispatches AS (
  SELECT "conversationId", COUNT(*) AS requests
  FROM inbound_turns
  WHERE "generationEngine" = 'nous_hermes_normal'
    AND "providerDispatchReservedAt" IS NOT NULL
  GROUP BY "conversationId"
), response_usage AS (
  SELECT "conversationId", metadata->>'conversationTurnId' AS turn_id,
         MAX(CASE WHEN jsonb_typeof(metadata->'tokensUsed') = 'number'
                  THEN (metadata->>'tokensUsed')::numeric END) AS tokens,
         MAX(CASE WHEN jsonb_typeof(metadata->'costEstimate') = 'number'
                  THEN (metadata->>'costEstimate')::numeric END) AS provider_cost_estimate
  FROM messages
  WHERE metadata->>'conversationEngine' = 'nous_hermes'
    AND metadata->>'conversationTurnId' IS NOT NULL
  GROUP BY "conversationId", metadata->>'conversationTurnId'
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
       c.ad_source_id,
       COUNT(*) AS conversations,
       COALESCE(SUM(m.inbound_messages), 0) AS inbound_messages,
       COALESCE(SUM(m.ad_referral_messages), 0) AS ad_referral_messages,
       COALESCE(SUM(m.later_ad_referral_messages), 0)
         AS later_ad_referral_messages,
       COALESCE(SUM(v.qualified_leads), 0) AS qualified_leads,
       COALESCE(SUM(v.contracts_won), 0) AS contracts_won,
       COALESCE(SUM(v.contracts_lost), 0) AS contracts_lost,
       COALESCE(SUM(d.requests), 0) AS nous_requests,
       COALESCE(SUM(d.requests), 0) * CAST(:'cost_per_request' AS numeric)
         AS estimated_usd,
       COALESCE(SUM(u.response_turns), 0) AS response_turns,
       COALESCE(SUM(u.token_known_turns), 0) AS token_known_turns,
       COALESCE(SUM(u.provider_cost_known_turns), 0)
         AS provider_cost_known_turns,
       SUM(u.known_tokens) AS known_tokens,
       SUM(u.known_provider_cost_estimate) AS known_provider_cost_estimate,
       NULL::numeric AS billed_usd
FROM pilot_conversations c
LEFT JOIN inbound_metrics m ON m."conversationId" = c.id
LEFT JOIN verified_commercial v ON v."conversationId" = c.id
LEFT JOIN dispatches d ON d."conversationId" = c.id
LEFT JOIN usage_by_conversation u ON u."conversationId" = c.id
GROUP BY c.origin, c.ad_source_id
ORDER BY c.origin, c.ad_source_id NULLS FIRST;
