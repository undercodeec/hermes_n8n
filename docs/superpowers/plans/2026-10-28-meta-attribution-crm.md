# Meta Attribution CRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give authorized CRM staff a safe, filterable view of Meta WhatsApp origins, later references, and verified acquisition results.

**Architecture:** Hermes projects safe attribution fields from persisted conversation/message metadata, filters before pagination, and computes an authenticated summary. Next.js consumes these endpoints through its existing proxy and displays acquisition UI alongside existing Google Ads screens.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Jest, Next.js/React, node:test.

**Spec:** `docs/superpowers/specs/2026-10-28-meta-attribution-crm-design.md`

## Global Constraints

- Base Hermes on `888a5c02692613e4f524dfda0c63fee150c5a513`; keep production and Nous untouched.
- Preserve `meta_ad`, verified `organic`, and `unknown`, including immutable initial origin.
- Never expose raw `ctwa_clid`, private engine metadata, or synthetic advertising metrics.
- No Meta Marketing API, production deployment, schema migration, or real customer data.

## Review Focus

- Legacy `organic` without post evidence must appear as `unknown`.
- An ad referral after the first message must not change initial origin.
- Lead list must not serialize raw webhook payloads.
- Origin filters must run before pagination and keep total counts accurate.
- Summary counts verified, noninvalidated commercial events without duplicate leads.

---

### Task 1: Safe projection and origin filtering

**Files:** `src/attribution-crm/*`, `src/conversations/*`, `src/leads/*`.

- [ ] Add failing tests for safe message serialization and origin classification/filtering.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement shared safe projection and use it in conversations and leads, retaining UI fields.
- [ ] Add optional `origin` query validation and SQL-side filters before pagination.
- [ ] Run focused suites and compile.

### Task 2: Safe attribution contract and summary API

**Files:** `src/attribution-crm/*`, `src/conversations/*`, `src/leads/*`, analytics controller/module.

- [ ] Add failing tests for later references, verified summary, date bounds, permissions.
- [ ] Run tests and confirm expected failures.
- [ ] Expose attribution on lists/details and implement authenticated summary endpoint.
- [ ] Run focused suites and compile.

### Task 3: CRM interface

**Files:** `src/lib/hermes/api.js`, CRM Inbox, leads, acquisition page, shell and styles, frontend tests.

- [ ] Add failing frontend contract/render tests.
- [ ] Run tests and confirm expected failures.
- [ ] Add origin labels/filters/detail, new acquisition dashboard and navigation.
- [ ] Run frontend tests, lint and build.

### Task 4: Final verification and report

**Files:** `HERMES_A7_D21_META_ATTRIBUTION_CRM_UI_REPORT.md`.

- [ ] Audit backend response surfaces and no secret leakage.
- [ ] Run backend and frontend suites/builds, review diffs.
- [ ] Commit locally in separate branches; document contract, evidence, limitations, and publication plan.
