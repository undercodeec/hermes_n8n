-- Run with psql -X -A -F, -t -v ON_ERROR_STOP=1 -f scripts/undercode-pilot-report.fixture.sql
-- Temporary tables shadow production tables only for this connection.
BEGIN;
CREATE TEMP TABLE conversations (id text, "createdAt" timestamptz, metadata jsonb);
CREATE TEMP TABLE inbound_turns (
  "conversationId" text, "generationEngine" text,
  "providerDispatchReservedAt" timestamptz
);
CREATE TEMP TABLE messages (
  id text, "conversationId" text, direction text,
  "createdAt" timestamptz, metadata jsonb
);
CREATE TEMP TABLE leads (id text, "conversationId" text);
CREATE TEMP TABLE advertising_conversions (
  "leadId" text, "eventType" text, verified boolean,
  "invalidatedAt" timestamptz
);

INSERT INTO conversations VALUES
  ('ad-1', CURRENT_TIMESTAMP, '{"pilotOrigin":"meta_ad","pilotOriginEvidence":"meta_referral_ad","pilotAd":{"sourceId":"ad-7"}}'),
  ('organic-1', CURRENT_TIMESTAMP, '{"pilotOrigin":"organic","pilotOriginEvidence":"meta_referral_post"}'),
  ('unknown-1', CURRENT_TIMESTAMP, '{"pilotOrigin":"unknown","pilotOriginEvidence":"insufficient"}'),
  ('legacy-organic', CURRENT_TIMESTAMP, '{"pilotOrigin":"organic"}');
INSERT INTO inbound_turns VALUES
  ('ad-1', 'nous_hermes_normal', CURRENT_TIMESTAMP),
  ('ad-1', 'nous_hermes_normal', CURRENT_TIMESTAMP),
  ('organic-1', 'nous_hermes_normal', CURRENT_TIMESTAMP);
INSERT INTO messages VALUES
  ('ad-in-1', 'ad-1', 'INBOUND', CURRENT_TIMESTAMP - INTERVAL '2 minutes', '{"pilotOrigin":"meta_ad","pilotAd":{"sourceId":"ad-7"}}'),
  ('ad-in-2', 'ad-1', 'INBOUND', CURRENT_TIMESTAMP - INTERVAL '1 minute', '{"pilotOrigin":"meta_ad","pilotAd":{"sourceId":"ad-8"}}'),
  ('organic-in', 'organic-1', 'INBOUND', CURRENT_TIMESTAMP, '{}'),
  ('unknown-in', 'unknown-1', 'INBOUND', CURRENT_TIMESTAMP, '{}'),
  ('legacy-in', 'legacy-organic', 'INBOUND', CURRENT_TIMESTAMP, '{}'),
  ('ad-out-1', 'ad-1', 'OUTBOUND', CURRENT_TIMESTAMP, '{"conversationEngine":"nous_hermes","conversationTurnId":"turn-1","tokensUsed":100,"costEstimate":3e-6}'),
  ('ad-out-2', 'ad-1', 'OUTBOUND', CURRENT_TIMESTAMP, '{"conversationEngine":"nous_hermes","conversationTurnId":"turn-1"}'),
  ('organic-out', 'organic-1', 'OUTBOUND', CURRENT_TIMESTAMP, '{"conversationEngine":"nous_hermes","conversationTurnId":"turn-2"}');
INSERT INTO leads VALUES ('lead-ad', 'ad-1'), ('lead-organic', 'organic-1');
INSERT INTO advertising_conversions VALUES
  ('lead-ad', 'LEAD_QUALIFIED', TRUE, NULL),
  ('lead-ad', 'CONTRACT_WON', TRUE, NULL),
  ('lead-ad', 'CONTRACT_LOST', FALSE, NULL),
  ('lead-organic', 'LEAD_QUALIFIED', TRUE, CURRENT_TIMESTAMP);

\set cost_per_request 0.02
\ir undercode-pilot-report.sql
ROLLBACK;
