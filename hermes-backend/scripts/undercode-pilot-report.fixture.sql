-- Run with psql -X -A -F, -t -f scripts/undercode-pilot-report.fixture.sql
-- Temporary tables shadow production tables only for this connection.
BEGIN;
CREATE TEMP TABLE conversations (id text, "createdAt" timestamptz, metadata jsonb);
CREATE TEMP TABLE inbound_turns (
  "conversationId" text, "generationEngine" text,
  "providerDispatchReservedAt" timestamptz
);
CREATE TEMP TABLE messages ("conversationId" text, metadata jsonb);

INSERT INTO conversations VALUES
  ('ad-1', CURRENT_TIMESTAMP, '{"pilotOrigin":"meta_ad"}'),
  ('organic-1', CURRENT_TIMESTAMP, '{"pilotOrigin":"organic"}');
INSERT INTO inbound_turns VALUES
  ('ad-1', 'nous_hermes_normal', CURRENT_TIMESTAMP),
  ('ad-1', 'nous_hermes_normal', CURRENT_TIMESTAMP),
  ('organic-1', 'nous_hermes_normal', CURRENT_TIMESTAMP);
INSERT INTO messages VALUES
  ('ad-1', '{"conversationEngine":"nous_hermes","conversationTurnId":"turn-1","tokensUsed":100,"costEstimate":3e-6}'),
  ('ad-1', '{"conversationEngine":"nous_hermes","conversationTurnId":"turn-1"}'),
  ('organic-1', '{"conversationEngine":"nous_hermes","conversationTurnId":"turn-2"}');

\set cost_per_request 0.02
\ir undercode-pilot-report.sql
ROLLBACK;
