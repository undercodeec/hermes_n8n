import { resolveVerifiedBlackFridayAd } from './verified-ad-campaign';

const config = {
  sourceIds: 'black-friday-ad-1,black-friday-ad-2',
  fallbackEnabled: false,
  startsAt: '2026-10-30T00:00:00.000Z',
  endsAt: '2026-11-02T00:00:00.000Z',
};
const now = new Date('2026-10-30T12:00:00.000Z');
const verified = (sourceId?: string) => ({
  pilotOrigin: 'meta_ad',
  pilotOriginEvidence: 'meta_referral_ad',
  pilotAd: sourceId ? { sourceId } : {},
});

describe('verified Black Friday ad campaign', () => {
  it('maps only an allowlisted Meta source ID', () => {
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified('black-friday-ad-1'),
        now,
        config,
      }),
    ).toEqual({
      policyVersion: 'black-friday-landing-80-v1',
      source: 'SOURCE_ID',
    });
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified('other-ad'),
        now,
        config,
      }),
    ).toBeUndefined();
  });

  it('allows a time-bound fallback only for a verified ad without a source ID', () => {
    const fallback = { ...config, fallbackEnabled: true };
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified(),
        now,
        config: fallback,
      })?.source,
    ).toBe('VERIFIED_META_AD_FALLBACK');
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified('other-ad'),
        now,
        config: fallback,
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: {
          pilotOrigin: 'organic',
          pilotOriginEvidence: 'meta_referral_post',
        },
        now,
        config: fallback,
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: {
          pilotOrigin: 'meta_ad',
          pilotOriginEvidence: 'customer_claim',
        },
        now,
        config: fallback,
      }),
    ).toBeUndefined();
  });

  it('expires the campaign and never revives an old ad attribution', () => {
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified('black-friday-ad-1'),
        now: new Date('2026-11-03T00:00:00Z'),
        config,
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata: verified('black-friday-ad-1'),
        conversationCreatedAt: new Date('2026-10-20T00:00:00Z'),
        now,
        config,
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata: verified('black-friday-ad-1'),
        conversationCreatedAt: now,
        now,
        config,
      })?.source,
    ).toBe('SOURCE_ID');
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata: verified('black-friday-ad-1'),
        conversationCreatedAt: new Date('2026-10-20T12:00:00Z'),
        now,
        config: { ...config, startsAt: '2026-10-01T00:00:00Z' },
      }),
    ).toBeUndefined();
  });

  it('uses the latest verified referral in an existing conversation', () => {
    const conversationMetadata = verified('black-friday-ad-1');
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata,
        conversationCreatedAt: now,
        priorMetadata: verified('other-ad'),
        priorOccurredAt: now,
        now,
        config,
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata: { pilotOrigin: 'unknown' },
        conversationCreatedAt: new Date('2026-10-20T00:00:00Z'),
        priorMetadata: verified('black-friday-ad-2'),
        priorOccurredAt: now,
        now,
        config,
      })?.source,
    ).toBe('SOURCE_ID');
  });
});
