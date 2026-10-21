# F3 retrieval canary — local preparation

Result: **BLOCKED_F3_RETRIEVAL_CANARY_QA_CONVERSATION_MISSING**. F3 remains OPEN. Base: `66cd47722372f8252d0df49610b21403b6171d5f`; preparation branch: `f3-retrieval-canary-gate`.

A fail-closed retrieval conversation scope was added before the selector. A global ON flag with an empty, malformed or multiple-ID allowlist cannot retrieve. Exactly one safe ID is permitted; non-QA turns skip the selector. More than one selected learning item also causes no injection for this first canary. The new allowlist and flag require a controlled process restart because ConfigModule snapshots validated environment at startup.

Local validation: 1300/1300 unit tests and 101/101 relevant isolated PostgreSQL/Redis integration tests passed. Build, production typecheck, ESLint, Prettier, Prisma validation and diff check passed. Schema and migrations: unchanged.

The prompt/session did not provide a previously designated QA conversation ID, authorization for its live delivery, an authorized LearningItem ID/version, or a canary owner. No VPS preflight, deployment, provider call, Meta/WhatsApp delivery or production flag change was performed. Live flag state was not inspected and is not asserted here.

Report SHA-256: `76622f79143dadc4310bc4b444916be79142f08c084b04f0ff33f06ae76ff731`.
