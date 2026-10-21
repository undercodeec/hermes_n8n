# F3 commercial precedence — offline authority map

Base: `620c64de00e6efc4447d060a51f0d927da288121`. The gate exercises retrieval locally with fake providers. Production learning flags remain OFF.

| Domain | Authoritative source in this codebase | Learning influence | Enforcement exercised |
|---|---|---|---|
| Price and currency | Active `Product`/`PriceList` assembled by `CommercialAuthorityService` into `CommercialSnapshot` | Conversational style only | `reviewCommercialClaims` checks amount, currency, offer and scope; `answerExplicitPriceIfMissing` uses the snapshot. |
| Tax and product scope | `PriceList` tax mode/rate and active product scope | None | `reviewCommercialClaims` removes unsupported tax and inclusion claims. |
| Discount and promotion | Current approved offer and commercial policy | None | Candidate validation excludes sales instructions; common `CommercialPolicyService` repair and `reviewCommercialClaims` reject unsupported output. |
| Payment terms | Approved commercial policy/knowledge; no learning authority | None | `hasUnauthorizedPaymentTerms` and common post-engine repair reject unapproved splits, installments and advances. |
| Timeline | Approved delivery policy or offer estimate in the snapshot | Style only | Common repair rejects unsupported delivery commitments; AutoReply checks a requested timeline against authorized days and conditional wording. |
| Availability | No affirmative availability source is exposed to learning retrieval | None | Common repair removes claims of confirmed or guaranteed availability. |
| Handoff | `CommercialPolicyService` intent analysis, conversation state and `HandoffService` | None | Human request and complaint guards run before retrieval or engine invocation. |
| Meeting and executed actions | Backend operation result and agent proposal policy | None | Proposal validation and common post-engine repair remove unconfirmed action claims; delivery records only confirmed dispatches. |

The pre-engine filter uses `validateCandidateSafety` and `commercialFailure` through the shared retrieval selector. Clear commercial instructions and the tested ambiguous sales language are excluded. The post-engine repair is shared by Gemini Direct and Nous, followed by snapshot claim review and delivery guards. Safe interaction guidance still reaches the selected engine, and `learningExposed` contains only IDs and versions present in its request.

The corpus is synthetic and finite. The keyword boundary cannot establish semantic safety for every paraphrase; the remaining approval, privacy isolation and traceability gates stay open. The latency report is descriptive (`THRESHOLD_NOT_DEFINED`).
