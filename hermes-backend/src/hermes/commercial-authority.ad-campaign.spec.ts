import { CommercialPriceType, CommercialTaxMode, Prisma } from '@prisma/client';
import {
  CommercialAuthorityService,
  commercialSnapshotKnowledge,
} from './commercial-authority.service';
import { BLACK_FRIDAY_LANDING_POLICY_VERSION } from './black-friday-landing';
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

function authority(active: boolean) {
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
            priceLists: promotionActive ? [base, promotion] : [base],
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
