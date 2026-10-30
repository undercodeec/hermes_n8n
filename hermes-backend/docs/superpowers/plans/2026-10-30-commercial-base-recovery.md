# Selective Commercial Base Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a verified, selective procedure to restore only Landing Básica and its USD 250 global tariff before the already published Black Friday migration is applied.

**Architecture:** A read-only SQL preflight classifies the two expected rows and conflicting identities. A separate PostgreSQL transaction serializes repair attempts, rejects mismatches, inserts only missing authorized rows, and rechecks the result. Integration tests exercise real SQL against an isolated temporary PostgreSQL cluster and then apply the existing Black Friday migration.

**Tech Stack:** PostgreSQL SQL and PL/pgSQL, Prisma migrations, Node test runner, Windows local PostgreSQL 18.

**Spec:** `ProyectMD/prompt.md` (30 October 2026, selective commercial catalog recovery).

## Global Constraints

- Local Windows only; no SSH, production DB, deployment, Black Friday activation, or new GHCR image.
- Preserve all other product and tariff rows. No `TRUNCATE`, `DROP`, `DELETE`, `_prisma_migrations` writes, or historical seed replay.
- Source authorized values from `20260923020000_seed_global_commercial_prices` and `20260925120000_commercial_plan_terms`; promotion remains owned by `20261029200000_black_friday_landing_80`.
- Product ID `commercial-product-landing-basic`, SKU `commercial-landing-basic`; price ID `commercial-price-landing-basic-global-v1`, USD 250, `global-v1`, active, tax INCLUDED/IVA.
- No new production backup per owner waiver `DATABASE_BACKUP_WAIVED_BY_OWNER`; record lack of a recently verified recovery point.

## Design choices

- Replaying the old nine-product seed would violate selectivity. A new Prisma migration would change the already published source image. Use a standalone, pinned SQL artifact instead.
- Existing rows are preserved only when their authorized commercial fields match. Timestamps are operational values and need only be valid, not identical to seed-time timestamps. Extra metadata keys are preserved because the later migration explicitly merged `commercialTerms` into existing metadata; the `commercialTerms` value itself must match exactly.
- A short transaction lock over `products` and `price_lists`, plus unique constraints and an advisory lock, prevents simultaneous incompatible repairs. Lock and statement timeouts fail closed.

## Review Focus

1. Same SKU with a different ID must classify conflict and change nothing.
2. Same price ID with changed amount, product, tax, or scope must classify conflict and change nothing.
3. Product exists but tariff does not: preserve the product and insert only the tariff.
4. Repeated execution must leave exactly one product and one base tariff.
5. A failed postcondition or concurrent execution must roll back completely.

---

### Task 1: Read-only preflight and transactional repair

**Files:** Create `hermes-backend/scripts/commercial-base-recovery/preflight.sql`, `repair.sql`, and `verify.sql`.

- [ ] Write an integration test that expects explicit classifications for missing, partial, valid, and conflicting states; run it and observe failure because scripts do not exist.
- [ ] Add read-only preflight with counts and a single verdict. Ensure no write statements.
- [ ] Add transaction with timeout, locks, exact authorized values, conflict checks, selective inserts, and postconditions. No silent UPSERT.
- [ ] Add postcheck that verifies IDs, product relationship, commercial fields, active state, and no duplicates.
- [ ] Run the focused test to green.

### Task 2: Isolated database scenarios

**Files:** Create `hermes-backend/scripts/commercial-base-recovery/test-repair.mjs`.

- [ ] Set up temporary local PostgreSQL database and apply the schema/migrations to the state immediately before Black Friday; use synthetic rows only.
- [ ] Test all requested scenarios: both missing, product only, both valid, SKU conflict, tariff conflict, repeated run, injected failure, rollback, FK integrity, and concurrent attempts.
- [ ] Apply the Black Friday migration after repair and assert USD 80, inactive, linked to the base, with no duplicates.
- [ ] Run full backend Jest suite and build; report actual results.

### Task 3: Handoff and publication

**Files:** Create `HERMES_COMMERCIAL_BASE_RECOVERY_REPORT_2026-10-30.md`; update no backend runtime files.

- [ ] Record the proven source values, SQL identity/checksum, exact Git commit, pre/post commands, blocking conditions, backup waiver, and unresolved cause investigation.
- [ ] Review SQL and test output, run `git diff --check`, commit the artifact, and push `fix/commercial-base-recovery-20261030` without changing pilot or backend main.
- [ ] Verify the remote branch SHA and report `READY_FOR_VPS_CATALOG_REPAIR` only if all gates pass.
