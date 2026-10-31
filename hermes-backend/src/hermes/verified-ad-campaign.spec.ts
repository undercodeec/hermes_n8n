import { resolveVerifiedBlackFridayAd } from './verified-ad-campaign';

const config = {
  sourceIds: '52583085497631',
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
  it('recognizes the approved Ad ID with no campaign dates', () => {
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified('52583085497631'),
        currentOccurredAt: now,
        now,
        config: { ...config, startsAt: '', endsAt: '' },
      }),
    ).toEqual({
      policyVersion: 'black-friday-landing-80-v1',
      source: 'SOURCE_ID',
    });
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified('another-ad'),
        currentOccurredAt: now,
        now,
        config: { ...config, startsAt: '', endsAt: '' },
      }),
    ).toBeUndefined();
  });

  it('keeps a seven-day attribution limit without campaign dates', () => {
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata: verified('52583085497631'),
        conversationCreatedAt: new Date('2026-10-22T12:00:00Z'),
        now,
        config: { ...config, startsAt: '', endsAt: '' },
      }),
    ).toBeUndefined();
  });

  it('validates each optional bound and never opens an unbounded fallback', () => {
    const metadata = verified('52583085497631');
    const withoutDates = { ...config, startsAt: '', endsAt: '' };
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: metadata,
        now,
        config: { ...withoutDates, startsAt: 'not-a-date' },
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: metadata,
        now,
        config: { ...withoutDates, startsAt: '2026-11-01T00:00:00Z' },
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: metadata,
        now,
        config: { ...withoutDates, endsAt: '2026-10-29T00:00:00Z' },
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: metadata,
        now,
        config: { ...withoutDates, startsAt: '2026-10-29T00:00:00Z' },
      })?.source,
    ).toBe('SOURCE_ID');
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: metadata,
        now,
        config: { ...withoutDates, endsAt: '2026-11-01T00:00:00Z' },
      })?.source,
    ).toBe('SOURCE_ID');
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: metadata,
        now,
        config: {
          ...withoutDates,
          startsAt: '2026-10-30T12:00:00Z',
          endsAt: '2026-10-30T12:00:00Z',
        },
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: metadata,
        now,
        config: { ...withoutDates, startsAt: '2026-02-30T00:00:00Z' },
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified(),
        now,
        config: { ...withoutDates, fallbackEnabled: true },
      }),
    ).toBeUndefined();
  });

  it('maps only an allowlisted Meta source ID', () => {
    expect(
      resolveVerifiedBlackFridayAd({
        currentMetadata: verified('52583085497631'),
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
        currentMetadata: verified('52583085497631'),
        now: new Date('2026-11-03T00:00:00Z'),
        config,
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata: verified('52583085497631'),
        conversationCreatedAt: new Date('2026-10-20T00:00:00Z'),
        now,
        config,
      }),
    ).toBeUndefined();
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata: verified('52583085497631'),
        conversationCreatedAt: now,
        now,
        config,
      })?.source,
    ).toBe('SOURCE_ID');
    expect(
      resolveVerifiedBlackFridayAd({
        conversationMetadata: verified('52583085497631'),
        conversationCreatedAt: new Date('2026-10-20T12:00:00Z'),
        now,
        config: { ...config, startsAt: '2026-10-01T00:00:00Z' },
      }),
    ).toBeUndefined();
  });

  it('uses the latest verified referral in an existing conversation', () => {
    const conversationMetadata = verified('52583085497631');
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
        priorMetadata: verified('52583085497631'),
        priorOccurredAt: now,
        now,
        config,
      })?.source,
    ).toBe('SOURCE_ID');
  });
});
