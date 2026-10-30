import { CommercialPriceType, CommercialTaxMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CommercialAuthorityService,
  commercialSnapshotKnowledge,
} from './commercial-authority.service';
import {
  answerExplicitPriceIfMissing,
  reviewCommercialClaims,
} from './commercial-claims';
import { CommercialPolicyService } from './commercial-policy.service';

describe('Black Friday landing commercial authority', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const base = {
    id: 'commercial-price-landing-basic-global-v1',
    name: 'Tarifa global vigente',
    price: new Prisma.Decimal('250.00'),
    currency: 'USD',
    market: null,
    priceType: CommercialPriceType.FIXED,
    taxMode: CommercialTaxMode.INCLUDED,
    taxLabel: 'IVA',
    taxRatePercent: null,
    scope: 'Landing Básica normal',
    restrictions: null,
    policyVersion: 'global-v1',
    isPromotion: false,
    supersedesPriceListId: null,
    validUntil: null,
  };
  const promotion = {
    ...base,
    id: 'commercial-price-landing-black-friday-80-global-v1',
    name: 'Black Friday — Landing Page',
    price: new Prisma.Decimal('80.00'),
    taxMode: null,
    taxLabel: null,
    scope:
      'Captación de leads; landing page de una sola sección; diseño responsive para celulares; botón flotante de WhatsApp y llamada directa; formulario de contacto o captura de prospectos; apartado de beneficios del servicio o producto; dominio .com y hosting básico por 1 año; 5 correos corporativos; SEO técnico base; 1 mes de soporte posterior a la entrega.',
    restrictions:
      'No incluye tienda online. Impuestos y renovaciones posteriores requieren confirmación.',
    policyVersion: 'black-friday-landing-80-v1',
    isPromotion: true,
    supersedesPriceListId: base.id,
  };

  function authority(prices: Array<typeof base | typeof promotion>) {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'commercial-product-landing-basic',
            name: 'Landing Básica',
            serviceCode: 'LANDING_PAGE',
            metadata: {
              commercialTerms: {
                renewalUsdPerYear: 80,
                estimatedBusinessDays: 10,
              },
            },
            priceLists: prices,
          },
        ]),
      },
    } as unknown as PrismaService;
    return new CommercialAuthorityService(prisma);
  }

  it('authorizes the campaign only for an explicit Black Friday inquiry', async () => {
    const result = await authority([base, promotion]).snapshot({
      customerMessage: 'Vi su promoción de Black Friday. ¿Qué incluye?',
      priceRequested: true,
      now,
    });
    expect(result.offers).toEqual([
      expect.objectContaining({
        id: promotion.id,
        name: promotion.name,
        amount: '80.00',
        promotion: true,
      }),
    ]);
    expect(result.offers[0].taxMode).toBeUndefined();
    expect(result.offers[0].renewalUsdPerYear).toBeUndefined();
    expect(result.offers[0].estimatedBusinessDays).toBeUndefined();
    const knowledge = commercialSnapshotKnowledge(result).join('\n');
    for (const feature of [
      'Captación de leads',
      'una sola sección',
      'responsive para celulares',
      'WhatsApp y llamada directa',
      'formulario de contacto o captura de prospectos',
      'beneficios del servicio o producto',
      'dominio .com y hosting básico por 1 año',
      '5 correos corporativos',
      'SEO técnico base',
      '1 mes de soporte posterior a la entrega',
    ]) {
      expect(knowledge).toContain(feature);
    }
    expect(knowledge).toMatch(/diez|10/);
  });

  it('preserves the normal landing price for an ordinary inquiry', async () => {
    const result = await authority([base, promotion]).snapshot({
      customerMessage: 'Quiero una landing page para mi negocio',
      priceRequested: true,
      now,
    });
    expect(result.offers).toEqual([
      expect.objectContaining({
        id: base.id,
        amount: '250.00',
        promotion: false,
      }),
    ]);
  });

  it('uses campaign context for a follow-up about a specific inclusion', async () => {
    const result = await authority([base, promotion]).snapshot({
      customerMessage: '¿Incluye dominio?',
      recentCustomerMessages: ['Vi su promoción de Black Friday'],
      priceRequested: false,
      now,
    });
    expect(result.offers[0]?.id).toBe(promotion.id);
  });

  it('does not announce the $80 offer when the promotion is inactive', async () => {
    const result = await authority([base]).snapshot({
      customerMessage: '¿Sigue la promoción de Black Friday de $80?',
      priceRequested: true,
      now,
    });
    expect(result.offers).toEqual([]);
    expect(commercialSnapshotKnowledge(result).join(' ')).toMatch(
      /no est[aá] activa/i,
    );
    expect(answerExplicitPriceIfMissing('', result, true)).not.toContain('80');
  });

  it('does not invent taxes or include an online store in the campaign', async () => {
    const result = await authority([base, promotion]).snapshot({
      customerMessage:
        '¿La promoción Black Friday de $80 incluye tienda online?',
      priceRequested: true,
      now,
    });
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].serviceCode).toBe('LANDING_PAGE');
    expect(answerExplicitPriceIfMissing('', result, true)).toContain(
      'USD $80.00',
    );
    expect(answerExplicitPriceIfMissing('', result, true)).not.toMatch(
      /iva|impuestos/i,
    );
    expect(
      reviewCommercialClaims('La oferta incluye IVA.', result).reasons,
    ).toContain('TAX_CLAIM_NOT_AUTHORIZED');
    expect(
      reviewCommercialClaims('La tienda online cuesta USD $80.', result)
        .reasons,
    ).toContain('PRICE_NOT_AUTHORIZED');
  });

  it.each([
    'Incluye cinco correos corporativos.',
    'Incluye dominio .com durante un año.',
    'Incluye hosting básico durante un año.',
    'Incluye configuración SEO técnica básica.',
    'Incluye un mes de soporte posterior a la entrega.',
  ])(
    'keeps an officially confirmed inclusion through Nous claim repair: %s',
    async (answer) => {
      const snapshot = await authority([base, promotion]).snapshot({
        customerMessage: '¿Qué incluye la página de $80?',
        priceRequested: false,
        now,
      });
      const reviewed = new CommercialPolicyService().repairNousCommercialClaims(
        answer,
        commercialSnapshotKnowledge(snapshot),
        true,
      );
      expect(reviewed.response).toBe(answer);
      expect(reviewed.reasons).toEqual([]);
    },
  );
});
