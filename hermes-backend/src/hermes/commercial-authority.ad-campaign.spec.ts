import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
  Prisma,
} from '@prisma/client';
import {
  CommercialAuthorityService,
  commercialSnapshotKnowledge,
} from './commercial-authority.service';
import { BLACK_FRIDAY_LANDING_POLICY_VERSION } from './black-friday-landing';
import {
  answerExplicitPriceIfMissing,
  reviewCommercialClaims,
} from './commercial-claims';
import { PrismaService } from '../prisma/prisma.service';

const now = new Date('2026-10-30T12:00:00Z');
const base = {
  id: 'commercial-price-landing-basic-global-v1',
  name: 'Landing Page',
  price: new Prisma.Decimal('250'),
  currency: 'USD',
  market: null,
  priceType: CommercialPriceType.FIXED,
  taxMode: CommercialTaxMode.NOT_APPLICABLE as CommercialTaxMode | null,
  taxLabel: null,
  taxRatePercent: null,
  scope: 'Landing básica',
  restrictions: null,
  policyVersion: 'landing-basic-v1',
  isPromotion: false,
  supersedesPriceListId: null,
  validUntil: null,
};
const promotion = {
  ...base,
  id: 'commercial-price-landing-black-friday-80-global-v1',
  name: 'Black Friday — Landing Page',
  price: new Prisma.Decimal('80'),
  taxMode: null,
  policyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
  isPromotion: true,
  supersedesPriceListId: base.id,
  scope:
    'Captación de leads; una sección; móvil; WhatsApp y llamada; formulario; beneficios; dominio .com y hosting básico por un año; cinco correos corporativos; SEO técnico base; un mes de soporte',
};
const ecuadorPromotion = {
  ...promotion,
  market: CommercialMarket.EC,
};
const spanishPromotion = {
  ...promotion,
  id: 'commercial-price-landing-black-friday-80-es-v1',
  price: new Prisma.Decimal('80'),
  currency: 'EUR',
  market: CommercialMarket.ES,
};
const verifiedSpainAd = {
  policyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
  source: 'SOURCE_ID' as const,
  market: CommercialMarket.ES,
  currency: 'EUR' as const,
};
const verifiedEcuadorAd = {
  policyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
  source: 'SOURCE_ID' as const,
  market: CommercialMarket.EC,
  currency: 'USD' as const,
};

function authority(active: boolean, dualMarket = false, spanishOnly = false) {
  let promotionActive = active;
  const findMany = jest.fn(
    (input: { where: { serviceCode: { in: string[] } } }) => {
      const { where } = input;
      if (where.serviceCode.in.includes('LANDING_PAGE'))
        return [
          {
            id: 'landing',
            name: 'Landing Page',
            serviceCode: 'LANDING_PAGE',
            metadata: {},
            priceLists: promotionActive
              ? [
                  base,
                  ...(spanishOnly
                    ? []
                    : [dualMarket ? ecuadorPromotion : promotion]),
                  ...(dualMarket || spanishOnly ? [spanishPromotion] : []),
                ]
              : [base],
          },
        ];
      return [];
    },
  );
  return {
    service: new CommercialAuthorityService({
      product: { findMany },
    } as unknown as PrismaService),
    findMany,
    setPromotionActive: (value: boolean) => {
      promotionActive = value;
    },
  };
}

describe('Commercial Authority with verified ad context', () => {
  it('reads CRM activation on every turn without changing the base tariff', async () => {
    const { service, findMany, setPromotionActive } = authority(true);
    const input = {
      customerMessage: 'Hola, quiero más información',
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: false,
      now,
    };
    const first = await service.snapshot(input);
    expect(first.offers.map((offer) => offer.amount)).toEqual(['80.00']);
    setPromotionActive(false);
    const second = await service.snapshot(input);
    expect(second.offers).toEqual([]);
    expect(commercialSnapshotKnowledge(second).join(' ')).not.toContain(
      'USD $80',
    );
    setPromotionActive(true);
    const third = await service.snapshot(input);
    expect(third.offers.map((offer) => offer.amount)).toEqual(['80.00']);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(base.price.toString()).toBe('250');
    expect(promotion.price.toString()).toBe('80');
  });

  it('selects the active authorized Black Friday tariff for a generic incident message', async () => {
    const { service } = authority(true);
    const snapshot = await service.snapshot({
      customerMessage: '¡Hola! Quiero más información',
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: false,
      now,
    });
    expect(snapshot.offers).toEqual([
      expect.objectContaining({
        id: promotion.id,
        amount: '80.00',
        currency: 'USD',
      }),
    ]);
    expect(snapshot.recommendedOfferId).toBe(promotion.id);
  });

  it.each([
    [verifiedSpainAd, spanishPromotion.id, 'EUR', CommercialMarket.ES],
    [verifiedEcuadorAd, ecuadorPromotion.id, 'USD', CommercialMarket.EC],
  ])(
    'selects the market-specific CRM tariff for verified %p traffic',
    async (verifiedAd, id, currency, market) => {
      const { service } = authority(true, true);
      const snapshot = await service.snapshot({
        customerMessage: 'Hola, quiero más información sobre la promoción',
        verifiedAd,
        priceRequested: false,
        now,
      });
      expect(snapshot.market).toBe(market);
      expect(snapshot.marketSource).toBe('VERIFIED_AD');
      expect(snapshot.offers).toEqual([
        expect.objectContaining({ id, currency, market }),
      ]);
    },
  );

  it('does not present the global USD tariff for the verified Spain ad without an ES tariff', async () => {
    const { service } = authority(true);
    const snapshot = await service.snapshot({
      customerMessage: 'Hola, quiero más información sobre la promoción',
      verifiedAd: verifiedSpainAd,
      priceRequested: false,
      now,
    });
    expect(snapshot.offers).toEqual([]);
    expect(snapshot.needsCampaignTariffConfirmation).toBe(true);
    expect(commercialSnapshotKnowledge(snapshot).join(' ')).not.toMatch(
      /USD \$80|no está activa/iu,
    );
  });

  it('uses the existing global USD promotion for verified Ecuador traffic when no EC tariff exists', async () => {
    const { service } = authority(true);
    const snapshot = await service.snapshot({
      customerMessage: 'Hola, quiero información sobre la promoción',
      verifiedAd: verifiedEcuadorAd,
      priceRequested: false,
      now,
    });
    expect(snapshot.offers).toEqual([
      expect.objectContaining({ id: promotion.id, currency: 'USD' }),
    ]);
    expect(snapshot.needsMarketClarification).toBe(false);
  });

  it('does not quote an inactive Ecuador promotion', async () => {
    const { service } = authority(false, true);
    const snapshot = await service.snapshot({
      customerMessage: 'Hola, quiero información sobre la promoción',
      verifiedAd: verifiedEcuadorAd,
      priceRequested: true,
      now,
    });
    expect(snapshot.market).toBe(CommercialMarket.EC);
    expect(snapshot.offers).toEqual([]);
    expect(snapshot.needsCampaignTariffConfirmation).toBe(true);
    expect(answerExplicitPriceIfMissing('', snapshot, true)).not.toMatch(
      /USD\s*\$?80|€\s*80/iu,
    );
  });

  it('keeps the explicit project country and asks for clarification when it conflicts with the ad', async () => {
    const { service } = authority(true, true);
    const snapshot = await service.snapshot({
      customerMessage: 'Necesito una landing para Ecuador',
      verifiedAd: verifiedSpainAd,
      priceRequested: true,
      now,
    });
    expect(snapshot.market).toBe(CommercialMarket.EC);
    expect(snapshot.marketSource).toBe('CURRENT');
    expect(snapshot.offers).toEqual([]);
    expect(snapshot.needsAdMarketConflictClarification).toBe(true);
    expect(answerExplicitPriceIfMissing('Cuesta €80.', snapshot, true)).toMatch(
      /país que indicó/iu,
    );
    expect(
      answerExplicitPriceIfMissing('Cuesta €80.', snapshot, true),
    ).not.toMatch(/€80|USD|Ecuador o España/iu);
  });

  it.each([
    [verifiedSpainAd, 'Quiero la promoción de USD 80'],
    [verifiedEcuadorAd, 'Quiero la promoción de €80'],
  ])(
    'does not substitute another market currency for %p',
    async (verifiedAd, customerMessage) => {
      const { service } = authority(true, true);
      const snapshot = await service.snapshot({
        customerMessage,
        verifiedAd,
        priceRequested: true,
        now,
      });
      expect(snapshot.offers).toEqual([]);
      expect(snapshot.needsCampaignTariffConfirmation).toBe(true);
    },
  );

  it.each([
    [
      'Quiero información sobre la promoción de €80',
      'EUR',
      spanishPromotion.id,
    ],
    ['Quiero información sobre la promoción de $80', 'USD', promotion.id],
    ['Vi Black Friday para España', 'EUR', spanishPromotion.id],
    ['Vi Black Friday para Ecuador', 'USD', promotion.id],
  ])(
    'selects the authorized %s offer by current currency or market',
    async (customerMessage, currency, id) => {
      const { service } = authority(true, true);
      const snapshot = await service.snapshot({
        customerMessage,
        verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
        priceRequested: true,
        now,
      });
      expect(snapshot.offers).toEqual([
        expect.objectContaining({ id, currency, amount: '80.00' }),
      ]);
    },
  );

  it('keeps the euro offer on a follow-up without repeating the currency', async () => {
    const { service } = authority(true, true);
    const snapshot = await service.snapshot({
      customerMessage: 'Tengo una barbería',
      recentCustomerMessages: ['Vi su promoción de €80'],
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: false,
      now,
    });
    expect(snapshot.offers[0]).toMatchObject({
      id: spanishPromotion.id,
      currency: 'EUR',
    });
  });

  it('lets the customer currency override a stale profile market', async () => {
    const { service } = authority(true, true);
    const snapshot = await service.snapshot({
      customerMessage: 'Quiero la promoción de €80',
      profile: { market: CommercialMarket.EC },
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: true,
      now,
    });
    expect(snapshot.offers[0]).toMatchObject({
      id: spanishPromotion.id,
      currency: 'EUR',
    });
  });

  it('does not substitute USD or claim inactivity when EUR has no active tariff', async () => {
    const { service } = authority(true);
    const snapshot = await service.snapshot({
      customerMessage: 'Vi la promoción de €80',
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: true,
      now,
    });
    expect(snapshot.offers).toEqual([]);
    expect(snapshot.needsCampaignTariffConfirmation).toBe(true);
    const knowledge = commercialSnapshotKnowledge(snapshot).join(' ');
    expect(knowledge).toMatch(/verificar la tarifa aplicable/iu);
    expect(knowledge).not.toMatch(/no está activa|USD \$80/iu);
    expect(
      answerExplicitPriceIfMissing(
        'Quiero confirmar el importe.',
        snapshot,
        true,
      ),
    ).toMatch(/verificar la tarifa de Black Friday/iu);
  });

  it('shows both approved campaign currencies when neither currency nor market is known', async () => {
    const { service } = authority(true, true);
    const snapshot = await service.snapshot({
      customerMessage: 'Hola, quiero información de Black Friday',
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: false,
      now,
    });
    expect(snapshot.offers).toEqual([
      expect.objectContaining({ id: promotion.id, currency: 'USD' }),
      expect.objectContaining({ id: spanishPromotion.id, currency: 'EUR' }),
    ]);
    expect(snapshot.needsMarketClarification).toBe(false);
    const answer = answerExplicitPriceIfMissing('', snapshot, true);
    expect(answer).toMatch(/€80\.00.*USD \$80\.00/iu);
    expect(answer).not.toMatch(/¿El proyecto sería para Ecuador o España/iu);
    expect(reviewCommercialClaims(answer, snapshot).reasons).toEqual([]);
    expect(commercialSnapshotKnowledge(snapshot).join(' ')).not.toMatch(
      /no está activa/iu,
    );
  });

  it('labels the market when only one specific campaign offer is active', async () => {
    const { service } = authority(true, false, true);
    const snapshot = await service.snapshot({
      customerMessage: 'Hola, quiero información de Black Friday',
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: false,
      now,
    });
    expect(snapshot.offers).toEqual([
      expect.objectContaining({ id: spanishPromotion.id, currency: 'EUR' }),
    ]);
    expect(snapshot.needsMarketClarification).toBe(false);
  });

  it('does not substitute the landing for an explicit online store', async () => {
    const { service, findMany } = authority(true);
    const snapshot = await service.snapshot({
      customerMessage: 'Quiero una tienda online',
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: false,
      now,
    });
    expect(snapshot.relevantServiceCodes).toEqual(['ONLINE_STORE']);
    expect(findMany.mock.calls[0][0].where.serviceCode.in).toEqual([
      'ONLINE_STORE',
    ]);
  });

  it.each([
    'Quiero información sobre una tienda online',
    '¿Qué incluye una tienda online?',
  ])(
    'honors a current question about another product: %s',
    async (customerMessage) => {
      const { service } = authority(true);
      const snapshot = await service.snapshot({
        customerMessage,
        verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
        priceRequested: false,
        now,
      });
      expect(snapshot.relevantServiceCodes).toEqual(['ONLINE_STORE']);
      expect(snapshot.offers.some((offer) => offer.promotion)).toBe(false);
    },
  );

  it.each(['Quiero una página web corporativa', 'Busco una web corporativa'])(
    'honors an explicit website request despite the verified ad: %s',
    async (customerMessage) => {
      const { service } = authority(true);
      const snapshot = await service.snapshot({
        customerMessage,
        verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
        priceRequested: false,
        now,
      });
      expect(snapshot.relevantServiceCodes).toEqual(['WEBSITE']);
      expect(snapshot.offers.some((offer) => offer.promotion)).toBe(false);
    },
  );

  it('withholds the campaign price when the promotion is inactive', async () => {
    const { service } = authority(false);
    const snapshot = await service.snapshot({
      customerMessage: 'Me gustaría conseguir más información sobre esto',
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      priceRequested: false,
      now,
    });
    expect(snapshot.offers).toEqual([]);
    expect(commercialSnapshotKnowledge(snapshot).join(' ')).not.toContain(
      'USD $80',
    );
  });

  it('does not revive an old Black Friday mention after a newer unrelated ad', async () => {
    const { service } = authority(true);
    const snapshot = await service.snapshot({
      customerMessage: 'Quiero información',
      recentCustomerMessages: ['Vi la promoción Black Friday'],
      ignoreHistoricalPromotion: true,
      priceRequested: false,
      now,
    });
    expect(snapshot.offers.some((offer) => offer.promotion)).toBe(false);
  });

  it('keeps the established landing project after promotional attribution expires', async () => {
    const { service } = authority(true);
    const snapshot = await service.snapshot({
      customerMessage: 'Tengo una barbería',
      productOfInterest: 'Landing Page',
      recentCustomerMessages: ['Vi la promoción Black Friday'],
      ignoreHistoricalPromotion: true,
      priceRequested: false,
      now,
    });
    expect(snapshot.relevantServiceCodes).toEqual(['LANDING_PAGE']);
    expect(snapshot.offers.some((offer) => offer.promotion)).toBe(false);
  });
});
