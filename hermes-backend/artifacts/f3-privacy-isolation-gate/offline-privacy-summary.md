# F3 privacy isolation gate — offline

Result: F3_PRIVACY_ISOLATION_GATE_PROVEN_OFFLINE. Base: `a117e85c8eeb37eb96bb376c4a0a758ae94c6829`. F3 remains OPEN.

Fixture v1 SHA-256: `83d248654ef90d19b210129713f613006dbdf9ae0847ea0c27f355a08c39bfb6`. All inputs are synthetic.

| Engine | Safe learning | Foreign markers | Current B markers (at least) | Result |
|---|---:|---:|---:|---|
| gemini_direct | 2 | 0 | 2 | PASS |
| nous_hermes | 2 | 0 | 2 | PASS |

The real adapters were captured with deterministic fake HTTP. The source A evidence and context remained in PostgreSQL; the B request retained its own profile and summary. Delivery metadata contained only selected learning IDs and versions.

The filter excluded private email and phone guidance. HIGH risk and ineffective evidence remained excluded. An isolated PostgreSQL/Redis test verifies A records stay unchanged and deleted evidence removes eligibility.

Performance: 500 warmups and 2000 samples per operation; filter p50 0.0022 ms, p95 0.0033 ms; selector p50 0.1510 ms, p95 0.2085 ms. THRESHOLD_NOT_DEFINED.

Prisma schema changes: 0; new migration directories: 0; migrations required: no. Real provider, Meta and WhatsApp calls: 0. Production and flags: unchanged.

The final commit SHA cannot be embedded in an artifact tracked by that same commit. Read the containing Git commit; the final response records its SHA.

Reproduce locally from the backend directory: `npx jest --runInBand --silent`, `npm run test:learning:integration` with the isolated Docker Compose harness, then `node scripts/evaluate-f3-privacy-isolation.mjs`. The request capture assertions are in the cited Jest specs; this report does not store provider payloads.
