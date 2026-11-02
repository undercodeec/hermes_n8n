# Market and conversational continuity implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax.

**Goal:** Resolve the commercial market from auditable signals, keep PriceList as the only price authority, and maintain useful replies when a tariff is unavailable.

**Architecture:** Keep the existing Meta webhook attribution path and commercial authority. Add an independent market resolver that takes the existing customer WhatsApp ID; pass its result into the commercial snapshot. Repair only the response clauses that fail commercial review and add a brief, relevant continuation when the price cannot be quoted.

**Tech Stack:** NestJS, TypeScript, Prisma, Jest, libphonenumber-js.

**Spec:** `ProyectMD/prompt.md` in the parent workspace (supplied by the user).

## Global constraints

- No production database writes, migrations, real WhatsApp sends, or deployment.
- A phone prefix is a fallback signal, never proof of project location.
- Only active, compatible PriceLists authorize prices; no currency conversions or invented taxes.
- Preserve opt-out, handoff, deduplication, and existing security gates.

## Review focus

- Malformed and ambiguous phone IDs must resolve to UNKNOWN.
- A verified ad must outrank the phone signal; explicit project market must outrank both.
- A later referral must be considered without losing initial attribution.
- A missing Spanish tariff must never fall back to GLOBAL/USD.
- A rejected price clause must leave safe service information and at most one useful question.

### Task 1: Attribution audit and baseline

**Files:** `src/webhook/*`, `src/attribution-crm/*`, `src/hermes/verified-ad-campaign.ts`, final report.

- [ ] Trace referral ingestion, existing-conversation behavior, ad recency and later-ad priority.
- [ ] Add targeted attribution regressions where the current tests do not cover a required case.
- [ ] Run attribution tests and record verified facts and unknowns; keep this phase read only for webhook production code.

### Task 2: Independent multi-signal resolver

**Files:** Create `src/hermes/commercial-market-resolver.ts` and its spec; modify `commercial-authority.service.ts`, `auto-reply.service.ts`, package manifest/lock.

- [ ] Add failing tests for phone, project country, verified ad, current message, CRM and history precedence.
- [ ] Verify the tests fail for the missing behavior.
- [ ] Implement strict phone parsing and source codes, then pass `contact.waId` to both snapshot call sites.
- [ ] Run resolver, authority and auto-reply tests.

### Task 3: Price safety and conversational continuity

**Files:** `commercial-claims.ts`, `auto-reply.service.ts`, `nous-hermes.transport.ts`, their specs.

- [ ] Add failing tests for absent ES/EUR PriceList, confirmed country/currency, follow-up fragments, invalid names, opt-out and handoff.
- [ ] Verify the tests fail for the missing behavior.
- [ ] Preserve safe answer clauses, append a useful next step only when appropriate, and filter invalid first names.
- [ ] Run focused commercial and conversation suites.

### Task 4: Verification, report and PR

**Files:** `ProyectMD/HERMES_MARKET_PHONE_FALLBACK_CONVERSATIONAL_FIX_2026-11-02.md`.

- [ ] Run the complete unit, isolated integration, A7-D16, build, Prisma validate, secrets, ESLint, attribution and commercial regressions without a production database.
- [ ] Record results, unverified hypotheses, privacy and commercial risk, deployment and rollback instructions.
- [ ] Review the diff, commit the branch, and prepare an independent PR.
