# Meta attribution in UnderCodeEC CRM

## Intent and scope

Show the already persisted WhatsApp acquisition evidence to authorized CRM staff. Keep `meta_ad`, verified `organic` (Meta post referral), and `unknown` distinct. Preserve the first conversation origin, and list later ad referrals separately. Google Ads and Nous behavior remain unchanged.

## Approach

Expose a small, explicit `attribution` object on conversation and lead responses, with origin filters applied in SQL before pagination. Project messages to known CRM fields, removing raw Meta payloads and private engine metadata. Add a JWT and role protected analytics endpoint with verified commercial counts and daily/ad ID breakdowns. The frontend uses existing Hermes proxy, CRM session, cards and filters, with a separate acquisition page. This follows the existing API and UI architecture without a Meta Marketing API dependency.

An alternative was to parse raw metadata in Next.js; it would propagate private payloads and duplicate classification rules. Another was to use the pilot SQL report as the UI source; it has no authenticated endpoint or pagination. Both are unsuitable.

## Contract

`attribution: { origin, evidence, initialAdSourceId, ctwaClidPresent, laterAdReferences }`. Unknown and legacy metadata map to `unknown`. `sourceId` is a Meta identifier, never a campaign name. `laterAdReferences` exposes message ID, date, and optional source ID and click ID presence, never a raw click ID. Leads inherit their conversation's attribution. The summary uses a validated inclusive UTC date window, conversation creation date for acquisition, and only verified, noninvalidated commercial events. Unknown monetary values remain null.

## Security and operation

Every CRM message response uses a safe projection; SSE retains only existing notification fields. Roles stay `ADMIN` and `SALES_AGENT`. No schema migration, production write, WhatsApp send, Meta Marketing API call, or Nous change is in scope. Tests use synthetic rows and mocks locally.
