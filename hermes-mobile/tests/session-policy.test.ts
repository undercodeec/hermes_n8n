import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localInactivityElapsed, MOBILE_INACTIVITY_MS, serverIdleDeadline } from '../src/sessionPolicy';

test('local display lock starts at 24 hours without human interaction, not 30 minutes', () => {
  const started = 1_000;
  assert.equal(MOBILE_INACTIVITY_MS, 86_400_000);
  const deadline = serverIdleDeadline(MOBILE_INACTIVITY_MS, started);
  assert.equal(localInactivityElapsed(deadline, started + 31 * 60_000), false);
  assert.equal(localInactivityElapsed(deadline, started + MOBILE_INACTIVITY_MS - 1), false);
  assert.equal(localInactivityElapsed(deadline, started + MOBILE_INACTIVITY_MS), true);
});

test('invalid or missing server TTL fails closed; new TTL may only follow acknowledged activity', () => {
  assert.equal(serverIdleDeadline(undefined, 100), null);
  assert.equal(serverIdleDeadline(MOBILE_INACTIVITY_MS + 1, 100), null);
  assert.equal(serverIdleDeadline(0, 100), null);
  assert.equal(localInactivityElapsed(null, 100), true);
  const renewed = serverIdleDeadline(MOBILE_INACTIVITY_MS, 1_000);
  assert.equal(localInactivityElapsed(renewed, MOBILE_INACTIVITY_MS + 999), false);
});
