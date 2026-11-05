import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommercialAuthorityService } from './commercial-authority.service';
import { BLACK_FRIDAY_LANDING_POLICY_VERSION } from './black-friday-landing';

const basePrice = {
  id: 'landing-base',
  name: 'Landing Básica',
  price: new Prisma.Decimal('250.00'),
  currency: 'USD',
  market: CommercialMarket.EC,
  priceType: CommercialPriceType.FIXED,
  taxMode: CommercialTaxMode.INCLUDED,
  taxLabel: 'IVA',
  taxRatePercent: null,
  scope:
    'Landing de una sección; 12 meses de soporte técnico posteriores a la entrega',
  restrictions: null,
  policyVersion: 'commercial-12m',
  isPromotion: false,
  supersedesPriceListId: null,
  validUntil: null,
};
const promotion = {
  ...basePrice,
  id: 'black-friday-ec',
  name: 'Black Friday — Landing Page',
  price: new Prisma.Decimal('80.00'),
  scope:
    'Captación de leads; landing page de una sola sección; diseño responsive; WhatsApp; formulario; beneficios; dominio y hosting; cinco correos; SEO base; 12 meses de soporte técnico posteriores a la entrega',
  policyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
  isPromotion: true,
  supersedesPriceListId: basePrice.id,
};

function authority(includePromotion = true) {
  const findMany = jest.fn(
    (query: { where: { serviceCode: { in: string[] } } }) =>
      Promise.resolve(
        [
          {
            id: 'landing',
            name: 'Landing Básica',
            serviceCode: 'LANDING_PAGE',
            metadata: null,
            priceLists: includePromotion ? [basePrice, promotion] : [basePrice],
          },
          {
            id: 'website',
            name: 'Plan de Lanzamiento',
            serviceCode: 'WEBSITE',
            metadata: null,
            priceLists: [
              {
                ...basePrice,
                id: 'website-base',
                price: new Prisma.Decimal('360.00'),
              },
            ],
          },
          {
            id: 'store',
            name: 'Tienda de Lanzamiento',
            serviceCode: 'ONLINE_STORE',
            metadata: null,
            priceLists: [
              {
                ...basePrice,
                id: 'store-base',
                price: new Prisma.Decimal('550.00'),
              },
            ],
          },
        ].filter((product) =>
          query.where.serviceCode.in.includes(product.serviceCode),
        ),
      ),
  );
  return {
    service: new CommercialAuthorityService({
      product: { findMany },
    } as unknown as PrismaService),
    findMany,
  };
}

describe('active Black Friday priority from CRM', () => {
  it('loads a campaign and the requested website plans without a keyword', async () => {
    const { service, findMany } = authority();
    const result = await service.snapshot({
      customerMessage: 'Quiero información de una página web',
      waId: '593991234567',
      priceRequested: false,
      prioritizeActiveBlackFriday: true,
    });
    const query = findMany.mock.calls[0]?.[0];
    expect(query.where.serviceCode.in).toEqual(['WEBSITE', 'LANDING_PAGE']);
    expect(result.offers.map((offer) => offer.id)).toEqual(
      expect.arrayContaining(['black-friday-ec', 'website-base']),
    );
    expect(
      result.offers.find((offer) => offer.id === 'black-friday-ec')?.amount,
    ).toBe('80.00');
  });

  it('does not invent a promotion when no approved PriceList exists', async () => {
    const result = await authority(false).service.snapshot({
      customerMessage: 'Hola, quiero más información',
      waId: '593991234567',
      priceRequested: false,
      prioritizeActiveBlackFriday: true,
    });
    expect(result.offers.some((offer) => offer.promotion)).toBe(false);
  });

  it('keeps a store alternative when a Black Friday lead needs online sales', async () => {
    const result = await authority().service.snapshot({
      customerMessage: 'Quiero vender productos y cobrar por internet',
      waId: '593991234567',
      priceRequested: false,
      verifiedAdPolicyVersion: BLACK_FRIDAY_LANDING_POLICY_VERSION,
      prioritizeActiveBlackFriday: true,
    });
    expect(result.offers.map((offer) => offer.id)).toEqual(
      expect.arrayContaining(['black-friday-ec', 'store-base']),
    );
    expect(result.recommendedOfferId).toBe('store-base');
  });

  it('does not revive a promotion rejected by the customer', async () => {
    const result = await authority().service.snapshot({
      customerMessage: 'No me interesa Black Friday; quiero una tienda online',
      recentCustomerMessages: ['Vi Black Friday'],
      waId: '593991234567',
      priceRequested: false,
      prioritizeActiveBlackFriday: true,
    });
    expect(result.offers.some((offer) => offer.promotion)).toBe(false);
    expect(
      result.offers.some((offer) => offer.serviceCode === 'ONLINE_STORE'),
    ).toBe(true);
  });
});
