# F3 commercial precedence gate — offline report

Base commit: `620c64de00e6efc4447d060a51f0d927da288121`. Fixture SHA-256: `d529501a2d5cf7f1edcaf548eb3af0dc17fbdd48e2e8db710e873b13ebfa3e54`.

Selection: 24/24 expected; safe 5, excluded 19.
Adversarial output: 13/13 repaired or rejected. Actual engine adapters and fake providers: Gemini Direct and Nous tests.
Real provider traffic: 0. Prisma schema changes: 0; new migrations: 0.

| Series | n | min ms | max ms | mean ms | median ms | p50 ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| selectorMixed | 500 | 0.1937 | 0.5690 | 0.2069 | 0.1985 | 0.1985 | 0.2348 |
| postEngineRepair | 500 | 0.0102 | 0.1674 | 0.0118 | 0.0110 | 0.0110 | 0.0135 |

THRESHOLD_NOT_DEFINED. Local descriptive measurements only.

Tests: 73 unit suites / 1194 cases passed; 1 isolated PostgreSQL-Redis integration suite / 41 cases passed.
