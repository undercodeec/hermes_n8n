# F3 traceability gate — offline

**Result:** F3_TRACEABILITY_GATE_PROVEN_OFFLINE. **F3:** OPEN.

Base: `0ee1a8c10bfec43c7f53a3ae85763fb6f31886b4`. Final commit reference: `CONTAINING_GIT_COMMIT`. Branch: `f3-traceability-gate`.

The 30-case synthetic corpus (66e8a4d8d8e8817deee6e34792735b44625525e12d215275be7d394edb1e361a) covers selector filtering, both fake engine boundaries, budget omission, shadow isolation, provider failures, post-policy suppression, delivery states, retries, versions, evidence changes, malformed metadata and DB reconstruction.

`learningExposed` records only ID/version in the provider-visible request. It does not claim causal use or effectiveness. Part 0 owns exposure metadata; all parts must be CONFIRMED for confirmed-delivery analytics.

Unit: 1255/1255 in 76 suites. Integration: 80/80 in 4 suites on isolated PostgreSQL/Redis. External traffic: 0. Prisma schema and migrations: unchanged. Production and flags: unchanged.

Performance: 30 local samples per operation; threshold THRESHOLD_NOT_DEFINED. See JSON for min, max, mean, median, p50 and p95.
