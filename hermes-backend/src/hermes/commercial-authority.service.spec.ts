import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CommercialAuthorityService,
  resolveCommercialMarket,
} from './commercial-authority.service';

describe('CommercialAuthorityService', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const base = {
    id: 'base',
    name: 'Tarifa normal',
    price: new Prisma.Decimal('360.00'),
    currency: 'USD',
    market: CommercialMarket.EC,
    priceType: CommercialPriceType.FIXED,
    taxMode: CommercialTaxMode.INCLUDED,
    taxLabel: 'IVA',
    taxRatePercent: null,
    scope: 'Hasta cinco páginas',
    restrictions: null,
    policyVersion: 'policy-1',
    isPromotion: false,
    supersedesPriceListId: null,
    validUntil: null,
  };

  function service(prices: Array<typeof base>) {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'website',
        name: 'Web Lanzamiento',
        serviceCode: 'WEBSITE',
        priceLists: prices,
      },
    ]);
    const prisma = { product: { findMany } } as unknown as PrismaService;
    return { authority: new CommercialAuthorityService(prisma), findMany };
  }

  it('does not turn a profile location or phone number into a confirmed market', () => {
    expect(
      resolveCommercialMarket({
        customerMessage: '¿Cuánto cuesta la web? Mi número empieza por +34.',
        profile: { location: 'España' },
      }),
    ).toEqual({ source: 'UNKNOWN' });
  });

  it('prioritizes the customer market over the previously confirmed profile', () => {
    expect(
      resolveCommercialMarket({
        customerMessage: 'Este proyecto es para España',
        profile: { market: 'EC' },
      }),
    ).toEqual({ market: CommercialMarket.ES, source: 'CURRENT' });
  });

  it('uses the project market when residence and destination differ', () => {
    expect(
      resolveCommercialMarket({
        customerMessage: 'Soy de Ecuador, pero el proyecto es para España',
        profile: { market: 'EC' },
      }),
    ).toEqual({ market: CommercialMarket.ES, source: 'CURRENT' });
  });

  it('does not fall back to the profile after an ambiguous current comparison', () => {
    expect(
      resolveCommercialMarket({
        customerMessage: '¿Qué cambia entre Ecuador y España?',
        profile: { market: 'EC' },
      }),
    ).toEqual({ source: 'UNKNOWN' });
  });

  it('asks one market clarification only when a service price was requested', async () => {
    const { authority, findMany } = service([base]);
    const result = await authority.snapshot({
      customerMessage: '¿Cuánto cuesta un sitio web?',
      priceRequested: true,
      now,
    });
    expect(result.needsMarketClarification).toBe(true);
    expect(result.offers).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    const noPriceQuestion = await authority.snapshot({
      customerMessage: 'Quiero un sitio web',
      priceRequested: false,
      now,
    });
    expect(noPriceQuestion.needsMarketClarification).toBe(false);
  });

  it('selects only the relevant active market and date in the CRM query', async () => {
    const { authority, findMany } = service([base]);
    const result = await authority.snapshot({
      customerMessage: 'Quiero un sitio web para Ecuador',
      priceRequested: true,
      now,
    });
    expect(result.offers).toEqual([
      expect.objectContaining({
        amount: '360.00',
        currency: 'USD',
        priceType: CommercialPriceType.FIXED,
        scope: 'Hasta cinco páginas',
        policyVersion: 'policy-1',
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, serviceCode: { in: ['WEBSITE'] } },
        select: expect.objectContaining({
          priceLists: expect.objectContaining({
            where: expect.objectContaining({
              isActive: true,
              market: CommercialMarket.EC,
              validFrom: { lte: now },
              OR: [{ validUntil: null }, { validUntil: { gte: now } }],
            }),
          }),
        }),
      }),
    );
  });

  it('uses the service named in the current turn before stale profile services', async () => {
    const { authority, findMany } = service([base]);
    await authority.snapshot({
      customerMessage: '¿Cuánto cuesta una tienda online para Ecuador?',
      profile: { service: 'sitio web' },
      priceRequested: true,
      now,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, serviceCode: { in: ['ONLINE_STORE'] } },
      }),
    );
  });

  it('recovers the service from recent customer turns for a follow-up price question', async () => {
    const { authority, findMany } = service([base]);
    await authority.snapshot({
      customerMessage: '¿Cuánto cuesta para Ecuador?',
      recentCustomerMessages: ['Quiero una tienda online'],
      priceRequested: true,
      now,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, serviceCode: { in: ['ONLINE_STORE'] } },
      }),
    );
  });

  it('selects a linked live promotion and falls back to base when it expires', async () => {
    const promotion = {
      ...base,
      id: 'promo',
      name: 'Promoción',
      price: new Prisma.Decimal('300.00'),
      isPromotion: true,
      supersedesPriceListId: 'base',
      validUntil: new Date('2026-09-30T00:00:00.000Z'),
    };
    const active = await service([base, promotion]).authority.snapshot({
      customerMessage: 'Sitio web para Ecuador',
      priceRequested: false,
      now,
    });
    expect(active.offers).toEqual([
      expect.objectContaining({ amount: '300.00', promotion: true }),
    ]);
    const expired = await service([base]).authority.snapshot({
      customerMessage: 'Sitio web para Ecuador',
      priceRequested: false,
      now,
    });
    expect(expired.offers).toEqual([
      expect.objectContaining({ amount: '360.00', promotion: false }),
    ]);
  });

  it('does not authorize legacy rows without market and policy metadata', async () => {
    const { authority } = service([
      { ...base, market: null, policyVersion: null },
    ]);
    const result = await authority.snapshot({
      customerMessage: 'Sitio web para Ecuador',
      priceRequested: true,
      now,
    });
    expect(result.offers).toEqual([]);
  });

  it('does not transfer an Ecuador amount to Spain', async () => {
    const { authority } = service([base]);
    const result = await authority.snapshot({
      customerMessage: 'Quiero un sitio web para España',
      priceRequested: true,
      now,
    });
    expect(result.market).toBe(CommercialMarket.ES);
    expect(result.offers).toEqual([]);
  });

  it('accepts a Spain quote-only entry without inventing an amount', async () => {
    const quote = {
      ...base,
      id: 'quote-es',
      market: CommercialMarket.ES,
      currency: 'EUR',
      priceType: CommercialPriceType.QUOTE_REQUIRED,
      price: null,
      taxMode: CommercialTaxMode.NOT_APPLICABLE,
      taxLabel: null,
    };
    const { authority } = service([quote]);
    const result = await authority.snapshot({
      customerMessage: 'Sitio web para España',
      priceRequested: true,
      now,
    });
    expect(result.offers).toEqual([
      expect.objectContaining({
        priceType: CommercialPriceType.QUOTE_REQUIRED,
        currency: 'EUR',
      }),
    ]);
    expect(result.offers[0].amount).toBeUndefined();
  });
});
