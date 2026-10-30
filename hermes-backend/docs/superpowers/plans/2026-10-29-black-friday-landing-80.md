# Black Friday Landing $80 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let Nous answer confirmed questions about the temporary UnderCodeEC Black Friday Landing Page for USD $80 without changing normal plans.

**Architecture:** Reuse the CRM `PriceList` promotion link to Landing BÃ¡sica. Seed the promotional row inactive; operators activate or deactivate it through the existing price-list mechanism. Detect campaign intent from the current message or recent customer context before selecting the promotion. The CRM snapshot remains the sole authority for prices and scope passed to Nous.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Jest.

**Spec:** `D:/Documentos/Hermes/ProyectMD/prompt.md`

## Global Constraints

- Price: USD $80. No unconfirmed tax, delivery, payment, expiry, or renewal claims.
- The 10 confirmed features and one-section scope are the only promotional inclusions.
- No production connection, WhatsApp smoke, VPS deployment, or F3/F4 change.
- Keep regular plan prices and behavior for noncampaign queries.

## Review Focus

- A generic website or landing query must retain the normal plan.
- A follow-up question after Black Friday must retain campaign context.
- An inactive or expired promotion must not authorize USD $80.
- A store request must not turn the landing into checkout/e-commerce.
- Generated claims about taxes or extra features must be rejected.

---

### Task 1: Promotion selection and response knowledge

**Files:** `src/hermes/commercial-authority.service.ts`, `src/hermes/commercial-authority.service.spec.ts`, `src/hermes/commercial-claims.spec.ts`.

- [x] Add failing tests for campaign recognition, follow-up context, generic plan isolation, inactive promotion, the 10 inclusions, and unconfirmed tax handling.
- [x] Run focused Jest tests and confirm expected failures.
- [x] Add a narrow Black Friday matcher and select the linked live promotion only in campaign context.
- [x] Pass concise campaign instructions and complete confirmed scope to Nous through `commercialSnapshotKnowledge`.
- [x] Run focused tests to green.

### Task 2: Inactive CRM promotion data

**Files:** new Prisma SQL migration, migration contract test.

- [x] Add a failing test for USD $80, the linked base price, all ten features, no invented end date or tax mode, and `isActive=false`.
- [x] Add an idempotent migration seeding the dormant promotion row.
- [x] Run contract test and Prisma validation.

### Task 3: Integration, verification, and publication report

**Files:** affected integration tests and `HERMES_BLACK_FRIDAY_LANDING_80_IMPLEMENTATION_REPORT.md`.

- [x] Prove text and transcribed-audio paths use the same snapshot and one outbound generation; check name/no-name cases and store exclusion.
- [x] Run affected tests, full Jest suite, build, and nonmutating targeted ESLint.
- [x] Document activation/deactivation, test evidence, risks, Git state, and publication requirements.
- [x] Commit and publish the feature branch only. Do not deploy.
