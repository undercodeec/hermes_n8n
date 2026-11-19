/** The server controls expiry; a monotonic client deadline only hides stale data. */
export const MOBILE_INACTIVITY_MS = 24 * 60 * 60_000;

export function serverIdleDeadline(idleRemainingMs: unknown, requestStartedAt: number): number | null {
  if (typeof idleRemainingMs !== 'number' || !Number.isSafeInteger(idleRemainingMs) ||
      idleRemainingMs <= 0 || idleRemainingMs > MOBILE_INACTIVITY_MS) return null;
  return requestStartedAt + idleRemainingMs;
}

export function localInactivityElapsed(serverDeadline: number | null, now: number): boolean {
  return serverDeadline === null || now >= serverDeadline;
}
