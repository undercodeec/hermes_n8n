# F3 shadow gate — offline report

Base commit: `231b11954b53d3a299e9dc98dee8048ce2e2e0c9`. Fixture: `f3-shadow-synthetic-v1`, SHA-256 `c20f2967621a6144724c97c8d9f4fd12b704829553031219b9419ac8c7501188`.

Cases: 28/28 matched and deterministic. Gemini and Nous request/output parity: PASS with fakes.

Query: take 100; evidence take 1; max selected 3. Database side effects: none.

| Series | n | min ms | max ms | mean ms | median ms | p50 ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| selectorDb | 100 | 2.729 | 3.719 | 2.984 | 2.956 | 2.955 | 3.356 |
| selectorFake | 100 | 0.327 | 0.899 | 0.361 | 0.345 | 0.345 | 0.408 |
| shadowFlowFake | 100 | 0.339 | 0.698 | 0.370 | 0.355 | 0.355 | 0.419 |

THRESHOLD_NOT_DEFINED. Durations are descriptive offline measurements; they are not a production SLO.
