# Mobile G2 session API (backend)

All paths below are under `/api/auth`. Use the **same operator and OTP**, but a proof signed with audience `hermes-crm-mobile` exclusively for mobile; the web proof has audience `hermes-crm` and is rejected by mobile (and vice versa). Proof `jti` is consumed transactionally and persistently across **both** `/crm-proof` (web) and `/mobile/crm-proof`; a proof cannot be exchanged twice or on both clients. Neither exchange reactivates a disabled or demoted existing operator. This changes legacy web behavior intentionally: review before deployment.

| Method/path | Authentication | Input | Output |
| --- | --- | --- | --- |
| POST `/mobile/crm-proof` | None | `{ "proof": "..." }` | `{ user, accessToken, refreshToken, expiresAt }` |
| POST `/mobile/refresh` | None | `{ "refreshToken": "..." }` | `{ user, accessToken, refreshToken, expiresAt }` |
| GET `/mobile/session` | Bearer mobile access JWT | None | `{ active: true, expiresAt }` |
| POST `/mobile/activity` | Bearer mobile access JWT | None | `{ active: true, expiresAt }` |
| POST `/mobile/logout` | Bearer mobile access JWT | None | `{ revoked: true }` |
| POST `/mobile/revoke-all` | Bearer **web** JWT of the existing configured CRM operator (ADMIN) | None | `{ revokedSessions: number }` |

`accessToken` is a 5-minute JWT with `sid` and is checked against the persisted session **on every protected request**. `refreshToken` is a rotating opaque credential (only its SHA-256 digest is stored); use the newest value returned by refresh. Duplicate/concurrent use of an old value returns 401. Logout invalidates access and refresh tokens; do not reuse credentials. Store refresh credentials securely on the device, never in logs. Session expires after 30 minutes without explicit `POST /mobile/activity`; checking the session, polling, profile, and refreshing tokens **do not** renew activity. Call activity only for a genuine foreground operator interaction, not for app start, timers, or background traffic. A session can live without an absolute maximum if kept active by operator interaction. Responses include server-derived `expiresAt` (ISO 8601); the server, not the device, decides expiry. Expired/revoked sessions and reused proofs return 401.

Mobile JWTs are rejected by legacy `JwtAuthGuard` routes, including account registration, payments and messaging. Only explicit mobile session endpoints accept them. Granting mobile Inbox access needs a separately reviewed read-only API contract; this G2 release does not expose live CRM data to the app.

Mobile access JWTs use a domain-separated HMAC-derived key, not the legacy web JWT key. The new JWT strategy selects the key from the untrusted `typ` hint and verifies the signature before accepting claims. Rolling back to an older backend therefore cannot verify mobile JWTs with the legacy key; web JWTs remain compatible. A rollback still requires a planned window and reauthentication of mobile sessions, plus review of the durable proof ledger and schema. Never copy JWT keys or tokens to clients or logs.

**Rollback preflight:** do not drop the additive PostgreSQL tables. Older backends do not consult the durable proof ledger; to avoid replay during rollback, pause CRM proof exchanges and allow at least 210 seconds after the last signed proof (maximum accepted lifetime 180 seconds plus 30 seconds clock skew) before starting the older version, or perform an explicitly reviewed coordinated secret rotation. Old backends reject newly issued mobile JWTs because of key separation, but they do not enforce the new mobile session state. Coordinate the UnderCode OTP provider rollback separately; its old process-local OTP cannot read codes stored by the new provider.

Single-phone policy (owner decision): a new mobile proof exchange serializes on the operator row, revokes all older mobile sessions and creates the new one in one transaction. The previous phone immediately loses API and refresh access; the web session remains valid. Lost phone: the authorized operator can call `/mobile/revoke-all` from the existing web session to revoke the current phone, without ending the web JWT. No new user/role or device management UI is required. Do not put the web JWT in documentation, URLs or command-line history; test this workflow with a synthetic web JWT before release. If the web session is unavailable, use a separately approved operational database procedure, not a local logout on the lost phone.

Apply additive migration `20261117190000_mobile_sessions` before running the new backend. Keep the `consumed_crm_proofs` rows for at least their proof expiry (retaining them indefinitely also preserves replay evidence); do not remove unexpired rows. No production data or deployment is included here.

PostgreSQL integration test: apply migrations to a **disposable local** database named `hermes_g2`, set `HERMES_G2_TEST_DATABASE_URL` to its localhost connection URL, then run `npx jest --config ./test/jest-integration.json --runInBand test/mobile-session-postgres.integration-spec.ts`. The test skips without that local test URL.
