# Mobile G2 session API (backend)

All paths below are under `/api/auth`. Use the **same** short-lived signed UnderCode CRM proof as web. There is no new OTP or separate operator identity. Proof `jti` is consumed transactionally and persistently across **both** `/crm-proof` (web) and `/mobile/crm-proof`; a proof cannot be exchanged twice or on both clients. Mobile exchange does not reactivate disabled users; existing web reactivation behavior is unchanged.

| Method/path | Authentication | Input | Output |
| --- | --- | --- | --- |
| POST `/mobile/crm-proof` | None | `{ "proof": "..." }` | `{ user, accessToken, refreshToken, expiresAt }` |
| POST `/mobile/refresh` | None | `{ "refreshToken": "..." }` | `{ user, accessToken, refreshToken, expiresAt }` |
| GET `/mobile/session` | Bearer mobile access JWT | None | `{ active: true, expiresAt }` |
| POST `/mobile/activity` | Bearer mobile access JWT | None | `{ active: true, expiresAt }` |
| POST `/mobile/logout` | Bearer mobile access JWT | None | `{ revoked: true }` |

`accessToken` is a 5-minute JWT with `sid` and is checked against the persisted session **on every protected request**. `refreshToken` is a rotating opaque credential (only its SHA-256 digest is stored); use the newest value returned by refresh. Duplicate/concurrent use of an old value returns 401. Logout invalidates access and refresh tokens; do not reuse credentials. Store refresh credentials securely on the device, never in logs. Session expires after 30 minutes without explicit `POST /mobile/activity`; checking the session, polling, profile, and refreshing tokens **do not** renew activity. Call activity only for a genuine foreground operator interaction, not for app start, timers, or background traffic. A session can live without an absolute maximum if kept active by operator interaction. Responses include server-derived `expiresAt` (ISO 8601); the server, not the device, decides expiry. Expired/revoked sessions and reused proofs return 401.

Apply additive migration `20261117190000_mobile_sessions` before running the new backend. Keep the `consumed_crm_proofs` rows for at least their proof expiry (retaining them indefinitely also preserves replay evidence); do not remove unexpired rows. No production data or deployment is included here.

PostgreSQL integration test: apply migrations to a **disposable local** database named `hermes_g2`, set `HERMES_G2_TEST_DATABASE_URL` to its localhost connection URL, then run `npx jest --config ./test/jest-integration.json --runInBand test/mobile-session-postgres.integration-spec.ts`. The test skips without that local test URL.
