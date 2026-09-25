import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CommercialAuthorityService,
  commercialSnapshotKnowledge,
  resolveCommercialMarket,
} from './commercial-authority.service';

describe('CommercialAuthorityService', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  type PriceFixture = {
    id: string;
    name: string;
    price: Prisma.Decimal | null;
    currency: string;
    market: CommercialMarket | null;
    priceType: CommercialPriceType | null;
    taxMode: CommercialTaxMode | null;
    taxLabel: string | null;
    taxRatePercent: Prisma.Decimal | null;
    scope: string | null;
    restrictions: string | null;
    policyVersion: string | null;
    isPromotion: boolean;
    supersedesPriceListId: string | null;
    validUntil: Date | null;
  };
  const base: PriceFixture = {
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

  function service(prices: PriceFixture[] | (() => PriceFixture[])) {
    const findMany = jest.fn().mockImplementation(() => [
      {
        id: 'website',
        name: 'Web Lanzamiento',
        serviceCode: 'WEBSITE',
        priceLists: typeof prices === 'function' ? prices() : prices,
      },
    ]);
    const prisma = { product: { findMany } } as unknown as PrismaService;
    return { authority: new CommercialAuthorityService(prisma), findMany };
  }

  it.each([
    {
      message: 'Quiero promocionar mi negocio. ¿Qué opciones y precios tienen?',
      codes: ['LANDING_PAGE', 'WEBSITE'],
      amounts: ['250.00', '600.00', '1500.00', '360.00', '510.00', '1010.00'],
    },
    {
      message: 'Necesito una página web para mi empresa. ¿Qué precios tienen?',
      codes: ['WEBSITE'],
      amounts: ['360.00', '510.00', '1010.00'],
    },
    {
      message: 'Quiero vender zapatos por internet. ¿Qué precios tienen?',
      codes: ['ONLINE_STORE'],
      amounts: ['550.00', '850.00', '3490.00'],
    },
    {
      message:
        'Tengo reparación de lavadoras y zapatos. Para reparaciones quiero promocionar mis servicios y para zapatos quiero vender.',
      codes: ['ONLINE_STORE', 'LANDING_PAGE', 'WEBSITE'],
      amounts: [
        '550.00',
        '850.00',
        '3490.00',
        '250.00',
        '600.00',
        '1500.00',
        '360.00',
        '510.00',
        '1010.00',
      ],
    },
  ])(
    'loads only CRM offers for $message',
    async ({ message, codes, amounts }) => {
      const rows = [
        ...[
          ['LANDING_PAGE', 250, 600, 1500],
          ['WEBSITE', 360, 510, 1010],
          ['ONLINE_STORE', 550, 850, 3490],
        ].flatMap(([code, ...values]) =>
          values.map((amount) => ({
            id: `${code}-${amount}`,
            name: `${code} ${amount}`,
            serviceCode: code,
            priceLists: [
              {
                ...base,
                id: `${code}-${amount}-price`,
                price: new Prisma.Decimal(amount),
                market: null,
              },
            ],
          })),
        ),
      ];
      const findMany = jest
        .fn()
        .mockImplementation(
          (query: { where: { serviceCode: { in: string[] } } }) =>
            rows.filter((row) =>
              query.where.serviceCode.in.includes(String(row.serviceCode)),
            ),
        );
      const authority = new CommercialAuthorityService({
        product: { findMany },
      } as unknown as PrismaService);
      const snapshot = await authority.snapshot({
        customerMessage: message,
        priceRequested: true,
        now,
      });
      expect(snapshot.relevantServiceCodes).toEqual(codes);
      expect(snapshot.offers.map((offer) => offer.amount)).toHaveLength(
        amounts.length,
      );
      expect(snapshot.offers.map((offer) => offer.amount)).toEqual(
        expect.arrayContaining(amounts),
      );
      expect(snapshot.needsMarketClarification).toBe(false);
      expect(commercialSnapshotKnowledge(snapshot)).not.toContain(
        'No hay tarifas comerciales globales aprobadas y vigentes para los servicios consultados. No comunique importes.',
      );
    },
  );

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

  it('asks one market clarification only after checking for a global price', async () => {
    const { authority, findMany } = service([base]);
    const result = await authority.snapshot({
      customerMessage: '¿Cuánto cuesta un sitio web?',
      priceRequested: true,
      now,
    });
    expect(result.needsMarketClarification).toBe(true);
    expect(result.offers).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const noPriceQuestion = await authority.snapshot({
      customerMessage: 'Quiero un sitio web',
      priceRequested: false,
      now,
    });
    expect(noPriceQuestion.needsMarketClarification).toBe(false);
  });

  it('uses a global price without asking for a country', async () => {
    const { authority, findMany } = service([{ ...base, market: null }]);
    const result = await authority.snapshot({
      customerMessage: '¿Cuánto cuesta un sitio web?',
      priceRequested: true,
      now,
    });
    expect(result.needsMarketClarification).toBe(false);
    expect(result.offers).toEqual([
      expect.objectContaining({
        amount: '360.00',
        currency: 'USD',
        marketScope: 'GLOBAL',
      }),
    ]);
    expect(findMany).toHaveBeenCalled();
  });

  it('uses a global USD price for Spain without converting it', async () => {
    const { authority } = service([{ ...base, market: null }]);
    const result = await authority.snapshot({
      customerMessage: 'Quiero un sitio web para España',
      priceRequested: true,
      now,
    });
    expect(result.offers).toEqual([
      expect.objectContaining({ currency: 'USD', amount: '360.00' }),
    ]);
  });

  it('reads the current global CRM price on every snapshot', async () => {
    let prices = [{ ...base, market: null }];
    const { authority } = service(() => prices);
    const input = {
      customerMessage: '¿Cuánto cuesta un sitio web?',
      priceRequested: true,
      now,
    };

    expect((await authority.snapshot(input)).offers[0].amount).toBe('360.00');

    prices = [{ ...base, market: null, price: new Prisma.Decimal('425.00') }];

    expect((await authority.snapshot(input)).offers[0].amount).toBe('425.00');
  });

  it('selects active policy rows and applies the relevant market in memory', async () => {
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

  it('keeps the restaurant website plan and separates automated reservations', async () => {
    const products = [
      {
        id: 'launch',
        name: 'Plan de Lanzamiento',
        serviceCode: 'WEBSITE',
        metadata: {
          commercialTerms: { renewalUsdPerYear: 40, estimatedBusinessDays: 10 },
        },
        priceLists: [{ ...base, market: null, id: 'launch-price' }],
      },
      {
        id: 'growth',
        name: 'Plan de Crecimiento',
        serviceCode: 'WEBSITE',
        metadata: {
          commercialTerms: { renewalUsdPerYear: 40, estimatedBusinessDays: 20 },
        },
        priceLists: [
          {
            ...base,
            market: null,
            id: 'growth-price',
            price: new Prisma.Decimal('510.00'),
          },
        ],
      },
      {
        id: 'authority',
        name: 'Plan de Autoridad',
        serviceCode: 'WEBSITE',
        metadata: {
          commercialTerms: { renewalUsdPerYear: 80, estimatedBusinessDays: 20 },
        },
        priceLists: [
          {
            ...base,
            market: null,
            id: 'authority-price',
            price: new Prisma.Decimal('1010.00'),
          },
        ],
      },
    ];
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue(products) },
    } as unknown as PrismaService;
    const result = await new CommercialAuthorityService(prisma).snapshot({
      customerMessage:
        'Quiero recibir pedidos, captar clientes y reservas con calendario',
      profile: {
        service: 'sitio web',
        need: 'Restaurante: mostrar empresa y platos',
      },
      recentCustomerMessages: [
        'Quiero una página web muy sencilla',
        'Es para un restaurante',
      ],
      priceRequested: false,
      now,
    });
    expect(result.relevantServiceCodes).toEqual(['WEBSITE']);
    expect(
      result.offers.find((offer) => offer.id === result.recommendedOfferId),
    ).toEqual(
      expect.objectContaining({
        name: 'Plan de Lanzamiento',
        renewalUsdPerYear: 40,
        estimatedBusinessDays: 10,
      }),
    );
    expect(result.additionalScope).toContain(
      'Reservas con calendario o disponibilidad automática',
    );
    expect(commercialSnapshotKnowledge(result).join(' ')).toContain(
      'No presentes todo el proyecto como personalizado',
    );
    const growth = await new CommercialAuthorityService(prisma).snapshot({
      customerMessage: 'Necesito posicionamiento local y Analytics',
      profile: { service: 'sitio web' },
      priceRequested: false,
      now,
    });
    expect(
      growth.offers.find((offer) => offer.id === growth.recommendedOfferId),
    ).toEqual(
      expect.objectContaining({
        name: 'Plan de Crecimiento',
        estimatedBusinessDays: 20,
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

  it('uses the structured policy for a custom mobile-app timeline', async () => {
    const policy =
      'Aplicaciones móviles: mínimo aproximado de 30 días laborables, sujeto a valoración y entrega de material.';
    const findMany = jest.fn();
    const prisma = {
      knowledgeDocument: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ content: policy, isActive: true }),
      },
      product: { findMany },
    } as unknown as PrismaService;
    const result = await new CommercialAuthorityService(prisma).snapshot({
      customerMessage: '¿Cuál es el plazo de una app móvil?',
      priceRequested: false,
      now,
    });
    expect(result.offers).toEqual([]);
    expect(commercialSnapshotKnowledge(result)).toContain(policy);
    expect(findMany).not.toHaveBeenCalled();
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
