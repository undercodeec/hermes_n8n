# F3 approval authority — offline

Result: `F3_APPROVAL_GATE_PROVEN_OFFLINE`. Base: `a2a6cc4b0faaefd764f2f36fbc4b8fe6abc05c22`. The containing Git commit is the final commit reference. F3 remains OPEN.

Corpus v1 SHA-256: `29bcccc997ee5b8a138b5a34aabbdb675df9d9a2fdbc1942e0e3c3a56993fc08`. All data is synthetic.

| State before | Decision | State after | HTTP |
|---|---|---|---:|
| PROPOSED | APPROVE | ACTIVE | 201 |
| PROPOSED | REJECT | REJECTED | 201 |
| ACTIVE | RETIRE | RETIRED | 201 |
| PROPOSED | RETIRE | PROPOSED | 409 |
| ACTIVE | APPROVE | ACTIVE | 409 |
| ACTIVE | REJECT | ACTIVE | 409 |
| REJECTED | APPROVE | REJECTED | 409 |
| REJECTED | RETIRE | REJECTED | 409 |
| RETIRED | APPROVE | RETIRED | 409 |
| RETIRED | REJECT | RETIRED | 409 |
| RETIRED | RETIRE | RETIRED | 409 |

Only a DB-validated ADMIN JWT can decide. The reviewer produced confidence 1.0 with two source conversations and two evidence rows, yet the item remained PROPOSED until the human decision. The service uses an advisory transaction lock and a conditional state update; state and audit persist atomically.

Effective evidence, expiry, privacy, commercial safety, risk and selector limits still gate exposure after APPROVE. Invalidated evidence, REJECT and RETIRE removed eligibility. Both real adapters were inspected with deterministic fake HTTP; only valid ACTIVE guidance and its ID/version reached Gemini Direct and Nous.

| Local operation | Samples | Min ms | Max ms | Mean ms | Median ms | p50 ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| APPROVE | 20 | 8.062 | 16.966 | 8.927 | 8.412 | 8.406 | 9.420 |
| REJECT | 16 | 6.569 | 12.051 | 7.291 | 6.785 | 6.783 | 12.051 |
| RETIRE | 16 | 6.539 | 8.711 | 6.945 | 6.808 | 6.786 | 8.711 |
| SELECT_ACTIVE | 18 | 2.680 | 6.282 | 3.274 | 2.956 | 2.950 | 6.282 |
| SELECT_INELIGIBLE | 42 | 1.801 | 8.150 | 2.247 | 2.055 | 2.054 | 2.819 |

`THRESHOLD_NOT_DEFINED`. These are local PostgreSQL/selector timings; no production SLO is inferred.

Unit: 75 suites / 1241 cases. Isolated PostgreSQL/Redis integration: 2 suites / 72 cases. Build, typecheck, directed lint and Prettier, Prisma validation and diff check: PASS.

Prisma schema changed: no; new migrations: 0; migrations required: no. Real Gemini reviewer/conversation, Nous, Meta and WhatsApp traffic: 0. Production and flags: unchanged.

Reproduce from this backend: start `npm run learning:harness:up`, run `npm run test:learning:integration`, run `npx jest --runInBand --silent --json --outputFile=artifacts/f3-approval-gate/jest-unit.tmp.json`, then `node scripts/evaluate-f3-approval.mjs`. Remove temporary JSON and stop the harness afterward.
