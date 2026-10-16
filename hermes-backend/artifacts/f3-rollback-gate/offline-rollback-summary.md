# F3 rollback gate — offline

Result: **F3_ROLLBACK_GATE_PROVEN_OFFLINE**. Base: `83364e8d1175a05077d8e4b970fe2872bcdd6467`; result reference: `f3-rollback-gate`. F3 remains OPEN.

ConfigModule validates an environment snapshot at process startup. Disable `LEARNING_RETRIEVAL_ENABLED` in the intended runtime configuration and restart every chat process to apply OFF. New turns on the restarted processes skip the selector and omit approvedLearning; in-flight requests and durable PREPARED deliveries retain their earlier metadata. No database deletion, migration, Redis flush or engine switch is part of rollback.

Both Gemini Direct and Nous passed OFF→ON→OFF→OFF→OFF→ON with request learning counts `0,1,0,0,0,1`. Their normalized post-rollback requests match the original OFF baseline. The isolated database fixture preserved 4 items, 4 evidence rows, 3 audit rows, 5 deliveries and all historical trace metadata; re-enable selected the same ACTIVE item. Redis key hash was unchanged.

30 synthetic corpus cases are mapped to assertions in the AutoReply, engine adapter, configuration and PostgreSQL integration suites. Unit: 1270/1270 tests in 78 suites. Relevant integration: 101/101 tests in 9 suites. Performance is descriptive (20 fake-adapter samples per stage); THRESHOLD_NOT_DEFINED. External provider, Meta and WhatsApp traffic: 0. No production flag change.

Report SHA-256: `9abe9ad68e54edcf6674c768b6ae8b9b4ff29b211fdd7824709cc7095870df65`.
